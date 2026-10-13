-- The semantic RPC uses an empty search_path. Its existing trigger must not
-- depend on public being in the caller search_path to resolve the citext type.
-- Preserve all trigger behavior; qualify only its three citext references.
BEGIN;

CREATE OR REPLACE FUNCTION "public"."sync_expense_shares"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$declare
  k text; v jsonb;
  total numeric(14,4);
  emails_in_json public.citext[];
begin
  perform set_config('app.shares_write','1', true);
  /* 驗證總額（雙保險，與 validate_shares_sum 一致） */
  select coalesce(sum((value)::text::numeric), 0) into total
  from jsonb_each(new.shares_json);
  if abs(total - new.amount) > 0.01 then
    raise exception 'shares_json total (%, computed) != amount (%)', total, new.amount;
  end if;

  /* 收集 key */
  select array_agg((key)::public.citext) into emails_in_json
  from jsonb_each(new.shares_json);

  /* 刪除：JSON 中已不在的對象 */
  delete from public.expense_shares s
   where s.expense_id = new.id
     and (emails_in_json is null or s.user_email <> all(emails_in_json));

  /* Upsert：逐一同步 */
  for k, v in select key, value from jsonb_each(new.shares_json)
  loop
    insert into public.expense_shares (expense_id, user_email, share_amount)
    values (new.id, k::public.citext, (v)::text::numeric)
    on conflict (expense_id, user_email) do update
      set share_amount = excluded.share_amount;
  end loop;

  return new;
end$$;

COMMIT;
