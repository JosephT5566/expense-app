-- DRAFT: verified against the disposable frontend-contract fixture only.
-- Review the actual deployed schema/triggers/RLS/grants before applying outside tests.
begin;
create table public.semantic_entry_requests (
 user_id uuid not null, request_id uuid not null, input_hash text not null,
 expense_id uuid, result jsonb, created_at timestamptz not null default now(),
 primary key(user_id,request_id)
 -- No expense FK: snapshots/tombstones must survive expense deletion.
);
create table public.semantic_entry_quota (
 user_id uuid not null, day date not null, count integer not null check(count between 1 and 100),
 primary key(user_id,day)
);
alter table public.semantic_entry_requests enable row level security;
alter table public.semantic_entry_quota enable row level security;
revoke all on public.semantic_entry_requests,public.semantic_entry_quota from public,anon,authenticated;
grant select on public.semantic_entry_requests to authenticated;
create policy semantic_request_owner on public.semantic_entry_requests for select to authenticated using(user_id=auth.uid());
-- Service role grants are for operator/test management, never the runtime credential.
grant all on public.semantic_entry_requests,public.semantic_entry_quota to service_role;

create function public.consume_semantic_entry_quota() returns boolean
language plpgsql security definer set search_path='' as $$
declare caller uuid := auth.uid(); affected integer;
begin
 if caller is null then raise sqlstate 'PT401' using message='Authentication required'; end if;
 if not exists(select 1 from public.app_settings where id=true and (auth.jwt()->>'email')=any(allowed_emails)) then
  raise sqlstate 'PT403' using message='Membership required';
 end if;
 insert into public.semantic_entry_quota(user_id,day,count)
 values(caller,(now() at time zone 'Asia/Taipei')::date,1)
 on conflict(user_id,day) do update set count=public.semantic_entry_quota.count+1 where public.semantic_entry_quota.count<100;
 get diagnostics affected = row_count;
 return affected=1;
end;
$$;

create function public.create_semantic_expense(p_request_id uuid,p_input_hash text,p_expense jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 caller uuid := auth.uid(); caller_email text := auth.jwt()->>'email'; allowed text[];
 saved public.semantic_entry_requests%rowtype; created public.expenses%rowtype;
 amount_value numeric; timestamp_value timestamptz; share_total numeric; share_count integer;
 share record; expected_share numeric; first_email text; snapshot jsonb;
begin
 if caller is null then raise sqlstate 'PT401' using message='Authentication required'; end if;
 select allowed_emails into allowed from public.app_settings where id=true;
 if caller_email is null or allowed is null or not(caller_email=any(allowed)) then raise sqlstate 'PT403' using message='Membership required'; end if;
 if p_request_id is null or p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' then raise sqlstate 'PT400' using message='Invalid request identity'; end if;
 insert into public.semantic_entry_requests(user_id,request_id,input_hash)
 values(caller,p_request_id,p_input_hash) on conflict(user_id,request_id) do nothing;
 select * into strict saved from public.semantic_entry_requests where user_id=caller and request_id=p_request_id for update;
 if saved.input_hash<>p_input_hash then raise sqlstate 'PT409' using message='Request text conflict'; end if;
 if saved.result is not null then return jsonb_build_object('expense',saved.result,'replayed',true); end if;
 if jsonb_typeof(p_expense) is distinct from 'object' or
 not(p_expense ?& array['note','amount','currency','ts','payer_email','scope','shares_json','category_id','is_settled']) or
 (select count(*) from jsonb_object_keys(p_expense))<>9 then raise sqlstate 'PT422' using message='Invalid expense fields'; end if;
 if jsonb_typeof(p_expense->'note') is distinct from 'string' or length(btrim(p_expense->>'note'))=0 or
 jsonb_typeof(p_expense->'amount') is distinct from 'number' or
 p_expense->>'currency' is distinct from 'TWD' or
 p_expense->>'scope' not in ('personal','household') or p_expense->>'scope' is null or
 not coalesce((p_expense->>'payer_email')=any(allowed),false) or
 jsonb_typeof(p_expense->'is_settled') is distinct from 'boolean' or
 jsonb_typeof(p_expense->'ts') is distinct from 'string' or
 jsonb_typeof(p_expense->'category_id') is distinct from 'string' or
 jsonb_typeof(p_expense->'shares_json') is distinct from 'object' then raise sqlstate 'PT422' using message='Invalid expense values'; end if;
 amount_value := (p_expense->>'amount')::numeric;
 if amount_value<=0 or amount_value>9007199254740991 or trunc(amount_value)<>amount_value then raise sqlstate 'PT422' using message='Invalid amount'; end if;
 timestamp_value := (p_expense->>'ts')::timestamptz;
 if not isfinite(timestamp_value) or (timestamp_value at time zone 'Asia/Taipei')::time<>'00:00:00'::time or
 (timestamp_value at time zone 'Asia/Taipei')::date>(now() at time zone 'Asia/Taipei')::date then raise sqlstate 'PT422' using message='Invalid expense date'; end if;
 if not exists(select 1 from public.categories where id=(p_expense->>'category_id')::uuid and kind='expense') then raise sqlstate 'PT422' using message='Invalid category'; end if;
 share_total:=0; share_count:=0;
 for share in select key,value from jsonb_each(p_expense->'shares_json') loop
  if not(share.key=any(allowed)) or jsonb_typeof(share.value)<>'number' then raise sqlstate 'PT422' using message='Invalid share member'; end if;
  if (share.value::text)::numeric<0 or trunc((share.value::text)::numeric)<>(share.value::text)::numeric then raise sqlstate 'PT422' using message='Invalid share amount'; end if;
  share_total:=share_total+(share.value::text)::numeric; share_count:=share_count+1;
 end loop;
 if share_total<>amount_value or share_count=0 then raise sqlstate 'PT422' using message='Invalid share total'; end if;
 if p_expense->>'scope'='personal' then
  if p_expense->>'payer_email'<>caller_email or p_expense->'shares_json'<>jsonb_build_object(caller_email,amount_value) or
   (p_expense->>'is_settled')::boolean is distinct from true then raise sqlstate 'PT422' using message='Invalid personal expense'; end if;
 else
  if share_count<2 or (p_expense->>'is_settled')::boolean is distinct from false then raise sqlstate 'PT422' using message='Invalid household expense'; end if;
  select min(key collate "C") into first_email from jsonb_each(p_expense->'shares_json');
  for share in select key,value from jsonb_each(p_expense->'shares_json') loop
   expected_share:=floor(amount_value/share_count)+case when share.key=first_email then mod(amount_value,share_count) else 0 end;
   if (share.value::text)::numeric<>expected_share then raise sqlstate 'PT422' using message='Only equal splitting supported'; end if;
  end loop;
 end if;
 insert into public.expenses(note,amount,currency,ts,payer_email,scope,shares_json,category_id,is_settled)
 values(btrim(p_expense->>'note'),amount_value,'TWD',timestamp_value,p_expense->>'payer_email',p_expense->>'scope',p_expense->'shares_json',(p_expense->>'category_id')::uuid,(p_expense->>'is_settled')::boolean)
 returning * into created;
 snapshot:=jsonb_strip_nulls(to_jsonb(created));
 update public.semantic_entry_requests set expense_id=created.id,result=snapshot where user_id=caller and request_id=p_request_id;
 return jsonb_build_object('expense',snapshot,'replayed',false);
end;
$$;
revoke all on function public.create_semantic_expense(uuid,text,jsonb),public.consume_semantic_entry_quota() from public,anon;
grant execute on function public.create_semantic_expense(uuid,text,jsonb),public.consume_semantic_entry_quota() to authenticated;
notify pgrst,'reload schema';
commit;
