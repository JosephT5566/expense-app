-- DISPOSABLE SYNTHETIC FRONTEND-CONTRACT FIXTURE, NOT THE DEPLOYED SCHEMA.
-- Apply only to project_id=jopie-semantic-entry-test, before the draft migration.
create table public.app_settings (id boolean primary key default true, allowed_emails text[] not null);
insert into public.app_settings values (true, array['a@example.test','b@example.test']);
create table public.categories (id uuid primary key, name text not null, kind text not null, sort_order integer default 0);
insert into public.categories values ('11111111-1111-4111-8111-111111111111','其他','expense',0);
create table public.expenses (
 id uuid primary key default gen_random_uuid(), payer_email text not null, note text not null check(note <> 'fixture_insert_failure'),
 amount numeric not null check(amount>0), currency text not null, ts timestamptz not null,
 scope text not null, shares_json jsonb not null, category_id uuid references public.categories,
 is_settled boolean not null, meta text not null default '', notes text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create function public.semantic_fixture_allowed() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.app_settings where id=true and (auth.jwt()->>'email')=any(allowed_emails));
$$;
revoke all on function public.semantic_fixture_allowed() from public;
grant execute on function public.semantic_fixture_allowed() to authenticated;
alter table public.expenses enable row level security;
alter table public.categories enable row level security;
alter table public.app_settings enable row level security;
create policy fixture_expenses on public.expenses to authenticated using (public.semantic_fixture_allowed() and (scope='household' or payer_email=auth.jwt()->>'email')) with check (public.semantic_fixture_allowed() and (scope='household' or payer_email=auth.jwt()->>'email'));
create policy fixture_categories on public.categories for select to authenticated using (public.semantic_fixture_allowed());
create policy fixture_settings on public.app_settings for select to authenticated using (public.semantic_fixture_allowed());
grant select,insert,update,delete on public.expenses to authenticated;
grant select on public.app_settings,public.categories to authenticated;
grant all on public.expenses,public.app_settings,public.categories to service_role;
notify pgrst,'reload schema';
