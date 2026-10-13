-- Existing public application schema captured on 2026-10-13 (schema only).
-- Version sorts before the already-existing semantic-entry migration; not a historical change date.
-- Semantic objects are omitted because 202610120001_semantic_entry.sql supplies them.
-- Supabase managed auth/storage schemas and roles are prerequisites, not recreated here.
-- The captured schema uses citext installed in public; do not relocate that extension.
-- No expense rows, member emails, category seed data, credentials, or project keys are included.
BEGIN;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

SET statement_timeout = 0;

SET lock_timeout = 0;

SET idle_in_transaction_session_timeout = 0;

SET client_encoding = 'UTF8';

SET standard_conforming_strings = on;

SELECT pg_catalog.set_config('search_path', '', false);

SET check_function_bodies = false;

SET xmloption = content;

SET client_min_messages = warning;

SET row_security = off;

CREATE SCHEMA IF NOT EXISTS "public";

ALTER SCHEMA "public" OWNER TO "pg_database_owner";

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE OR REPLACE FUNCTION "public"."current_email"() RETURNS "public"."citext"
    LANGUAGE "sql" STABLE
    AS $$
  select coalesce(nullif((auth.jwt()->>'email')::citext, ''), null);
$$;

ALTER FUNCTION "public"."current_email"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."email_allowed"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1 from public.app_settings s
    where s.id = true and public.current_email() = any(s.allowed_emails)
  );
$$;

ALTER FUNCTION "public"."email_allowed"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."fn_category_breakdown"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text" DEFAULT 'all'::"text") RETURNS TABLE("category" "text", "owed_in_cat" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  select coalesce(c.name,'(未分類)') as category,
         sum(s.share_amount) as owed_in_cat
  from public.expense_shares s
  join public.expenses e on e.id = s.expense_id
  left join public.categories c on c.id = e.category_id
  where s.user_email = p_email
    and e.ts >= p_start and e.ts < p_end
    and (p_scope = 'all' OR e.scope = p_scope)
  group by 1
  order by owed_in_cat desc nulls last;
$$;

ALTER FUNCTION "public"."fn_category_breakdown"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."fn_insert_expense"("p_ts" timestamp with time zone, "p_payer_email" "public"."citext", "p_amount" numeric, "p_currency" "text", "p_category_id" "uuid", "p_note" "text", "p_shares_json" "jsonb", "p_meta" "jsonb" DEFAULT '{}'::"jsonb", "p_scope" "text" DEFAULT 'household'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare new_id uuid;
begin
  if p_scope not in ('household','personal') then
    raise exception 'invalid scope: %', p_scope;
  end if;

  insert into public.expenses (ts, payer_email, amount, currency, category_id, note, shares_json, meta, scope)
  values (coalesce(p_ts, now()), p_payer_email, p_amount, coalesce(p_currency,'TWD'), p_category_id, p_note, p_shares_json, p_meta, p_scope)
  returning id into new_id;

  return new_id;
end $$;

ALTER FUNCTION "public"."fn_insert_expense"("p_ts" timestamp with time zone, "p_payer_email" "public"."citext", "p_amount" numeric, "p_currency" "text", "p_category_id" "uuid", "p_note" "text", "p_shares_json" "jsonb", "p_meta" "jsonb", "p_scope" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."fn_list_expenses"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text" DEFAULT 'all'::"text", "p_query" "text" DEFAULT NULL::"text", "p_offset" integer DEFAULT 0, "p_limit" integer DEFAULT 50, "p_settled" boolean DEFAULT NULL::boolean) RETURNS TABLE("id" "uuid", "ts" timestamp with time zone, "payer_email" "public"."citext", "amount" numeric, "currency" "text", "category_id" "uuid", "note" "text", "shares_json" "jsonb", "meta" "jsonb", "scope" "text", "is_settled" boolean)
    LANGUAGE "sql" STABLE
    AS $$
  select e.id, e.ts, e.payer_email, e.amount, e.currency, e.category_id,
         e.note, e.shares_json, e.meta, e.scope, e.is_settled
  from public.expenses e
  where e.ts >= p_start and e.ts < p_end
    and (p_scope = 'all' or e.scope = p_scope)
    and (p_settled is null or e.is_settled = p_settled)
    and (
      e.payer_email = p_viewer_email
      or e.shares_json ? p_viewer_email
    )
    and (p_query is null or e.note ilike '%' || p_query || '%')
  order by e.ts desc
  offset greatest(p_offset, 0)
  limit greatest(p_limit, 1);
$$;

ALTER FUNCTION "public"."fn_list_expenses"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_query" "text", "p_offset" integer, "p_limit" integer, "p_settled" boolean) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."fn_mark_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[], "p_is_settled" boolean DEFAULT true) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  update public.expenses e
     set is_settled = p_is_settled,
         updated_at = now()
   where e.id = any(p_ids)
     and (
       e.payer_email = p_viewer_email
       or e.shares_json ? p_viewer_email
     );

  get diagnostics v_count = row_count;
  return v_count;
end $$;

ALTER FUNCTION "public"."fn_mark_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[], "p_is_settled" boolean) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."fn_mark_settled_range"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text" DEFAULT 'all'::"text", "p_is_settled" boolean DEFAULT true) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  if p_scope not in ('all','household','personal') then
    raise exception 'invalid scope: %', p_scope;
  end if;

  update public.expenses e
     set is_settled = p_is_settled,
         updated_at = now()
   where e.ts >= p_start
     and e.ts <  p_end
     and (p_scope = 'all' or e.scope = p_scope)
     and (
       e.payer_email = p_viewer_email
       or e.shares_json ? p_viewer_email
     );

  get diagnostics v_count = row_count;
  return v_count;
end $$;

ALTER FUNCTION "public"."fn_mark_settled_range"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_is_settled" boolean) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."fn_member_balances"("p_scope" "text", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_bucket_interval" interval DEFAULT '1 mon'::interval, "p_use_taipei_tz" boolean DEFAULT false) RETURNS TABLE("bucket_start" "date", "scope" "text", "email" "public"."citext", "paid" numeric, "owed" numeric, "net" numeric, "paid_by_category_id" "jsonb", "owed_by_category_id" "jsonb", "net_by_category_id" "jsonb")
    LANGUAGE "sql" STABLE
    AS $$
with base as (
  -- ① 付款方 → paid
  select
    (
      case when p_use_taipei_tz
        then date_bin(p_bucket_interval, e.ts at time zone 'Asia/Taipei', timestamp '1970-01-01')
        else date_bin(p_bucket_interval, e.ts,                              timestamp '1970-01-01')
      end
    )::date as bucket_start,
    e.scope,
    e.payer_email::citext as email,
    e.category_id,
    e.amount::numeric as paid,
    0::numeric as owed
  from public.expenses e
  where (p_scope is null or e.scope = p_scope)
    and e.ts >= p_start and e.ts < p_end

  union all

  -- ② 分攤方 → owed（從 expense_shares 展開）
  select
    (
      case when p_use_taipei_tz
        then date_bin(p_bucket_interval, e.ts at time zone 'Asia/Taipei', timestamp '1970-01-01')
        else date_bin(p_bucket_interval, e.ts,                              timestamp '1970-01-01')
      end
    )::date as bucket_start,
    e.scope,
    sh.user_email::citext as email,
    e.category_id,
    0::numeric as paid,
    sh.share_amount::numeric as owed
  from public.expense_shares sh
  join public.expenses e on e.id = sh.expense_id
  where (p_scope is null or e.scope = p_scope)
    and e.ts >= p_start and e.ts < p_end
),
cat as (
  -- 先彙總到「category_id」層級，之後再包成 jsonb
  select
    bucket_start, scope, email, category_id,
    sum(paid) as paid,
    sum(owed) as owed
  from base
  group by 1,2,3,4
)
select
  bucket_start,
  scope,
  email,
  sum(paid) as paid,
  sum(owed) as owed,
  (sum(paid) - sum(owed)) as net,
  jsonb_object_agg(category_id::text, paid)        filter (where category_id is not null) as paid_by_category_id,
  jsonb_object_agg(category_id::text, owed)        filter (where category_id is not null) as owed_by_category_id,
  jsonb_object_agg(category_id::text, paid - owed) filter (where category_id is not null) as net_by_category_id
from cat
group by 1,2,3
order by 1,2,3;
$$;

ALTER FUNCTION "public"."fn_member_balances"("p_scope" "text", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_bucket_interval" interval, "p_use_taipei_tz" boolean) OWNER TO "postgres";

COMMENT ON FUNCTION "public"."fn_member_balances"("p_scope" "text", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_bucket_interval" interval, "p_use_taipei_tz" boolean) IS '功能
  - 依指定時間區間與「分箱」(day/week/month...)，彙總每位成員（以 email 為鍵）的
    paid / owed / net，並同時輸出「依 category_id 匯總」的 JSONB。

  參數
  - p_scope            text
      指定欲過濾的 scope（例如 ''personal'' / ''household''）。傳 NULL 表示不過濾。
  - p_start            timestamptz
      查詢起始（含）。請以 UTC 或你系統慣用時區傳入。
  - p_end              timestamptz
      查詢結束（不含）。
  - p_bucket_interval  interval  default ''1 month''
      分箱長度：''1 day'' / ''1 week'' / ''1 month'' / ''3 months'' 等。
      需 PostgreSQL 14+（使用 date_bin）。若需相容更舊版本，可改用 date_trunc 版本。
  - p_use_taipei_tz    boolean   default false
      為 true 時，分箱會以 ''Asia/Taipei'' 本地時間對齊；否則以資料庫時區/UTC。

  回傳欄位
  - bucket_start           date       該桶的起始日期（依分箱與時區計算）
  - scope                  text
  - email                  citext     成員的 email（大小寫不敏感）
  - paid                   numeric    該桶內實付總額
  - owed                   numeric    該桶內應分攤總額
  - net                    numeric    paid - owed
  - paid_by_category_id    jsonb      {"<category_id>": amount, ...}
  - owed_by_category_id    jsonb
  - net_by_category_id     jsonb

  索引建議
  - create index on public.expenses (scope, ts);
  - create index on public.expenses (payer_email);               -- CITEXT
  - create index on public.expenses (scope, category_id, ts);
  - create index on public.expense_shares (expense_id);
  - create index on public.expense_shares (user_email);          -- 建議亦為 CITEXT

  使用範例
  -- 2025-07-01 ~ 2025-10-01，僅 household，按週分箱，以台灣時間對齊
  select *
  from public.fn_member_balances(''household'', ''2025-07-01'', ''2025-10-01'', ''1 week'', true);

  -- 任意區間、全部 scope、按天（UTC）
  select *
  from public.fn_member_balances(null, ''2025-09-01'', ''2025-10-01'', ''1 day'', false);

  注意
  - JSON 物件的 key 必須是字串，故將 category_id 轉為 text 作為 key。
  - 若你的 expenses/expense_shares 的 email 欄位皆為 CITEXT，這裡的 cast 會是 no-op。
';

CREATE OR REPLACE FUNCTION "public"."fn_period_summary"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text" DEFAULT 'all'::"text") RETURNS TABLE("email" "public"."citext", "paid" numeric, "owed" numeric, "net" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  with paid as (
    select coalesce(sum(amount),0) as v
    from public.expenses
    where payer_email = p_email
      and ts >= p_start and ts < p_end
      and (p_scope = 'all' OR scope = p_scope)
  ),
  owed as (
    select coalesce(sum(s.share_amount),0) as v
    from public.expense_shares s
    join public.expenses e on e.id = s.expense_id
    where s.user_email = p_email
      and e.ts >= p_start and e.ts < p_end
      and (p_scope = 'all' OR e.scope = p_scope)
  )
  select p_email,
         (select v from paid),
         (select v from owed),
         (select v from paid) - (select v from owed);
$$;

ALTER FUNCTION "public"."fn_period_summary"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."fn_toggle_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  update public.expenses e
     set is_settled = not e.is_settled,
         updated_at = now()
   where e.id = any(p_ids)
     and (
       e.payer_email = p_viewer_email
       or e.shares_json ? p_viewer_email
     );

  get diagnostics v_count = row_count;
  return v_count;
end $$;

ALTER FUNCTION "public"."fn_toggle_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[]) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;

ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."sync_expense_shares"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$declare
  k text; v jsonb;
  total numeric(14,4);
  emails_in_json citext[];
begin
  perform set_config('app.shares_write','1', true);
  /* 驗證總額（雙保險，與 validate_shares_sum 一致） */
  select coalesce(sum((value)::text::numeric), 0) into total
  from jsonb_each(new.shares_json);
  if abs(total - new.amount) > 0.01 then
    raise exception 'shares_json total (%, computed) != amount (%)', total, new.amount;
  end if;

  /* 收集 key */
  select array_agg((key)::citext) into emails_in_json
  from jsonb_each(new.shares_json);

  /* 刪除：JSON 中已不在的對象 */
  delete from public.expense_shares s
   where s.expense_id = new.id
     and (emails_in_json is null or s.user_email <> all(emails_in_json));

  /* Upsert：逐一同步 */
  for k, v in select key, value from jsonb_each(new.shares_json)
  loop
    insert into public.expense_shares (expense_id, user_email, share_amount)
    values (new.id, k::citext, (v)::text::numeric)
    on conflict (expense_id, user_email) do update
      set share_amount = excluded.share_amount;
  end loop;

  return new;
end$$;

ALTER FUNCTION "public"."sync_expense_shares"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."validate_shares_sum"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare total numeric(14,4);
begin
  select coalesce(sum((value)::text::numeric), 0) into total
  from jsonb_each(new.shares_json);
  if abs(total - new.amount) > 0.01 then
    raise exception 'shares_json total (%, computed) != amount (%)', total, new.amount;
  end if;
  return new;
end $$;

ALTER FUNCTION "public"."validate_shares_sum"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "allowed_emails" "public"."citext"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."app_settings" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "kind" "text" DEFAULT 'expense'::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_archived" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "categories_kind_check" CHECK (("kind" = ANY (ARRAY['expense'::"text", 'income'::"text"])))
);

ALTER TABLE "public"."categories" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."expense_shares" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "expense_id" "uuid" NOT NULL,
    "user_email" "public"."citext" NOT NULL,
    "share_amount" numeric(12,2) NOT NULL,
    "share_ratio" numeric(6,4),
    CONSTRAINT "expense_shares_share_amount_check" CHECK (("share_amount" >= (0)::numeric))
);

ALTER TABLE "public"."expense_shares" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ts" timestamp with time zone DEFAULT "now"() NOT NULL,
    "payer_email" "public"."citext" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'TWD'::"text" NOT NULL,
    "category_id" "uuid",
    "note" "text",
    "shares_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scope" "text" NOT NULL,
    "is_settled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "expenses_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "expenses_scope_ck" CHECK (("scope" = ANY (ARRAY['household'::"text", 'personal'::"text"])))
);

ALTER TABLE "public"."expenses" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."scheduled_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_email" "text" NOT NULL,
    "payer_email" "text" NOT NULL,
    "note" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "currency" "text" DEFAULT 'TWD'::"text" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "timezone" "text" DEFAULT 'Asia/Taipei'::"text" NOT NULL,
    "scope" "text" NOT NULL,
    "shares_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "category_id" "uuid",
    "kind" "text" DEFAULT 'one_time'::"text" NOT NULL,
    "recurrence_rule" "text",
    "recurrence_weekday" integer,
    "recurrence_month_day" integer,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_expense_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "monthly_requires_month_day" CHECK ((("recurrence_rule" <> 'monthly'::"text") OR ("recurrence_month_day" IS NOT NULL))),
    CONSTRAINT "recurring_requires_rule" CHECK ((("kind" = 'one_time'::"text") OR ("recurrence_rule" IS NOT NULL))),
    CONSTRAINT "scheduled_expenses_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "scheduled_expenses_kind_check" CHECK (("kind" = ANY (ARRAY['one_time'::"text", 'recurring'::"text"]))),
    CONSTRAINT "scheduled_expenses_recurrence_month_day_check" CHECK ((("recurrence_month_day" IS NULL) OR (("recurrence_month_day" >= 1) AND ("recurrence_month_day" <= 31)))),
    CONSTRAINT "scheduled_expenses_recurrence_rule_check" CHECK ((("recurrence_rule" IS NULL) OR ("recurrence_rule" = ANY (ARRAY['daily'::"text", 'weekly'::"text", 'monthly'::"text"])))),
    CONSTRAINT "scheduled_expenses_recurrence_weekday_check" CHECK ((("recurrence_weekday" IS NULL) OR (("recurrence_weekday" >= 0) AND ("recurrence_weekday" <= 6)))),
    CONSTRAINT "scheduled_expenses_scope_check" CHECK (("scope" = ANY (ARRAY['personal'::"text", 'household'::"text"]))),
    CONSTRAINT "scheduled_expenses_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "weekly_requires_weekday" CHECK ((("recurrence_rule" <> 'weekly'::"text") OR ("recurrence_weekday" IS NOT NULL)))
);

ALTER TABLE "public"."scheduled_expenses" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."v_monthly_member_balances" WITH ("security_invoker"='on') AS
 WITH "base" AS (
         SELECT ("date_trunc"('month'::"text", ("e"."ts" AT TIME ZONE 'Asia/Taipei'::"text")))::"date" AS "month",
            "e"."scope",
            "e"."payer_email" AS "email",
            "e"."category_id",
            ("e"."amount")::numeric AS "paid",
            (0)::numeric AS "owed"
           FROM "public"."expenses" "e"
        UNION ALL
         SELECT ("date_trunc"('month'::"text", "e"."ts"))::"date" AS "month",
            "e"."scope",
            "sh"."user_email" AS "email",
            "e"."category_id",
            (0)::numeric AS "paid",
            ("sh"."share_amount")::numeric AS "owed"
           FROM ("public"."expense_shares" "sh"
             JOIN "public"."expenses" "e" ON (("e"."id" = "sh"."expense_id")))
        ), "cat" AS (
         SELECT "base"."month",
            "base"."scope",
            "base"."email",
            "base"."category_id",
            "sum"("base"."paid") AS "paid",
            "sum"("base"."owed") AS "owed"
           FROM "base"
          GROUP BY "base"."month", "base"."scope", "base"."email", "base"."category_id"
        )
 SELECT "month",
    "scope",
    "email",
    "sum"("paid") AS "paid",
    "sum"("owed") AS "owed",
    ("sum"("paid") - "sum"("owed")) AS "net",
    "jsonb_object_agg"("category_id", "paid") FILTER (WHERE ("category_id" IS NOT NULL)) AS "paid_by_category",
    "jsonb_object_agg"("category_id", "owed") FILTER (WHERE ("category_id" IS NOT NULL)) AS "owed_by_category",
    "jsonb_object_agg"("category_id", ("paid" - "owed")) FILTER (WHERE ("category_id" IS NOT NULL)) AS "net_by_category"
   FROM "cat"
  GROUP BY "month", "scope", "email"
  ORDER BY "month", "scope", "email";

ALTER VIEW "public"."v_monthly_member_balances" OWNER TO "postgres";

ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_name_kind_key" UNIQUE ("name", "kind");

ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."expense_shares"
    ADD CONSTRAINT "expense_shares_expense_id_user_email_key" UNIQUE ("expense_id", "user_email");

ALTER TABLE ONLY "public"."expense_shares"
    ADD CONSTRAINT "expense_shares_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."scheduled_expenses"
    ADD CONSTRAINT "scheduled_expenses_pkey" PRIMARY KEY ("id");

CREATE INDEX "idx_expenses_is_settled_ts" ON "public"."expenses" USING "btree" ("is_settled", "ts" DESC);

CREATE INDEX "idx_expenses_note_trgm" ON "public"."expenses" USING "gin" ("note" "public"."gin_trgm_ops");

CREATE INDEX "idx_expenses_payer_email" ON "public"."expenses" USING "btree" ("payer_email");

CREATE INDEX "idx_expenses_scope_ts" ON "public"."expenses" USING "btree" ("scope", "ts" DESC);

CREATE INDEX "idx_expenses_ts" ON "public"."expenses" USING "btree" ("ts" DESC);

CREATE INDEX "idx_shares_expense" ON "public"."expense_shares" USING "btree" ("expense_id");

CREATE INDEX "idx_shares_user_email" ON "public"."expense_shares" USING "btree" ("user_email");

CREATE INDEX "scheduled_expenses_owner_kind_status_due_idx" ON "public"."scheduled_expenses" USING "btree" ("owner_email", "kind", "status", "scheduled_for");

CREATE INDEX "scheduled_expenses_owner_status_due_idx" ON "public"."scheduled_expenses" USING "btree" ("owner_email", "status", "scheduled_for");

CREATE OR REPLACE TRIGGER "t_expenses_updated_at" BEFORE UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

CREATE OR REPLACE TRIGGER "t_expenses_validate" BEFORE INSERT OR UPDATE OF "shares_json", "amount" ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."validate_shares_sum"();

CREATE OR REPLACE TRIGGER "trg_sync_shares" AFTER INSERT OR UPDATE OF "shares_json", "amount" ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."sync_expense_shares"();

ALTER TABLE ONLY "public"."expense_shares"
    ADD CONSTRAINT "expense_shares_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id");

ALTER TABLE ONLY "public"."scheduled_expenses"
    ADD CONSTRAINT "scheduled_expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."scheduled_expenses"
    ADD CONSTRAINT "scheduled_expenses_created_expense_id_fkey" FOREIGN KEY ("created_expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;

ALTER TABLE "public"."app_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_settings_select_authenticated" ON "public"."app_settings" FOR SELECT USING (("auth"."uid"() IS NOT NULL));

ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categories_all" ON "public"."categories" USING ("public"."email_allowed"()) WITH CHECK ("public"."email_allowed"());

ALTER TABLE "public"."expense_shares" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expenses_all" ON "public"."expenses" USING ("public"."email_allowed"()) WITH CHECK ("public"."email_allowed"());

CREATE POLICY "scheduled expenses deletable by owner" ON "public"."scheduled_expenses" FOR DELETE USING (("owner_email" = ("auth"."jwt"() ->> 'email'::"text")));

CREATE POLICY "scheduled expenses insertable by owner" ON "public"."scheduled_expenses" FOR INSERT WITH CHECK (("owner_email" = ("auth"."jwt"() ->> 'email'::"text")));

CREATE POLICY "scheduled expenses readable by owner" ON "public"."scheduled_expenses" FOR SELECT USING (("owner_email" = ("auth"."jwt"() ->> 'email'::"text")));

CREATE POLICY "scheduled expenses updatable by owner" ON "public"."scheduled_expenses" FOR UPDATE USING (("owner_email" = ("auth"."jwt"() ->> 'email'::"text"))) WITH CHECK (("owner_email" = ("auth"."jwt"() ->> 'email'::"text")));

ALTER TABLE "public"."scheduled_expenses" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shares_select_only" ON "public"."expense_shares" FOR SELECT USING ("public"."email_allowed"());

CREATE POLICY "shares_write_trigger_only_del" ON "public"."expense_shares" FOR DELETE USING (("current_setting"('app.shares_write'::"text", true) = '1'::"text"));

CREATE POLICY "shares_write_trigger_only_ins" ON "public"."expense_shares" FOR INSERT WITH CHECK (("current_setting"('app.shares_write'::"text", true) = '1'::"text"));

CREATE POLICY "shares_write_trigger_only_upd" ON "public"."expense_shares" FOR UPDATE USING (("current_setting"('app.shares_write'::"text", true) = '1'::"text")) WITH CHECK (("current_setting"('app.shares_write'::"text", true) = '1'::"text"));

GRANT USAGE ON SCHEMA "public" TO "postgres";

GRANT USAGE ON SCHEMA "public" TO "anon";

GRANT USAGE ON SCHEMA "public" TO "authenticated";

GRANT USAGE ON SCHEMA "public" TO "service_role";

GRANT ALL ON FUNCTION "public"."current_email"() TO "anon";

GRANT ALL ON FUNCTION "public"."current_email"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."current_email"() TO "service_role";

GRANT ALL ON FUNCTION "public"."email_allowed"() TO "anon";

GRANT ALL ON FUNCTION "public"."email_allowed"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."email_allowed"() TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_category_breakdown"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") TO "anon";

GRANT ALL ON FUNCTION "public"."fn_category_breakdown"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_category_breakdown"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_insert_expense"("p_ts" timestamp with time zone, "p_payer_email" "public"."citext", "p_amount" numeric, "p_currency" "text", "p_category_id" "uuid", "p_note" "text", "p_shares_json" "jsonb", "p_meta" "jsonb", "p_scope" "text") TO "anon";

GRANT ALL ON FUNCTION "public"."fn_insert_expense"("p_ts" timestamp with time zone, "p_payer_email" "public"."citext", "p_amount" numeric, "p_currency" "text", "p_category_id" "uuid", "p_note" "text", "p_shares_json" "jsonb", "p_meta" "jsonb", "p_scope" "text") TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_insert_expense"("p_ts" timestamp with time zone, "p_payer_email" "public"."citext", "p_amount" numeric, "p_currency" "text", "p_category_id" "uuid", "p_note" "text", "p_shares_json" "jsonb", "p_meta" "jsonb", "p_scope" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_list_expenses"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_query" "text", "p_offset" integer, "p_limit" integer, "p_settled" boolean) TO "anon";

GRANT ALL ON FUNCTION "public"."fn_list_expenses"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_query" "text", "p_offset" integer, "p_limit" integer, "p_settled" boolean) TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_list_expenses"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_query" "text", "p_offset" integer, "p_limit" integer, "p_settled" boolean) TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_mark_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[], "p_is_settled" boolean) TO "anon";

GRANT ALL ON FUNCTION "public"."fn_mark_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[], "p_is_settled" boolean) TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_mark_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[], "p_is_settled" boolean) TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_mark_settled_range"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_is_settled" boolean) TO "anon";

GRANT ALL ON FUNCTION "public"."fn_mark_settled_range"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_is_settled" boolean) TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_mark_settled_range"("p_viewer_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text", "p_is_settled" boolean) TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_member_balances"("p_scope" "text", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_bucket_interval" interval, "p_use_taipei_tz" boolean) TO "anon";

GRANT ALL ON FUNCTION "public"."fn_member_balances"("p_scope" "text", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_bucket_interval" interval, "p_use_taipei_tz" boolean) TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_member_balances"("p_scope" "text", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_bucket_interval" interval, "p_use_taipei_tz" boolean) TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_period_summary"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") TO "anon";

GRANT ALL ON FUNCTION "public"."fn_period_summary"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_period_summary"("p_email" "public"."citext", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_scope" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."fn_toggle_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[]) TO "anon";

GRANT ALL ON FUNCTION "public"."fn_toggle_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[]) TO "authenticated";

GRANT ALL ON FUNCTION "public"."fn_toggle_settled_ids"("p_viewer_email" "public"."citext", "p_ids" "uuid"[]) TO "service_role";

GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."sync_expense_shares"() TO "anon";

GRANT ALL ON FUNCTION "public"."sync_expense_shares"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."sync_expense_shares"() TO "service_role";

GRANT ALL ON FUNCTION "public"."validate_shares_sum"() TO "anon";

GRANT ALL ON FUNCTION "public"."validate_shares_sum"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."validate_shares_sum"() TO "service_role";

GRANT ALL ON TABLE "public"."app_settings" TO "anon";

GRANT ALL ON TABLE "public"."app_settings" TO "authenticated";

GRANT ALL ON TABLE "public"."app_settings" TO "service_role";

GRANT ALL ON TABLE "public"."categories" TO "anon";

GRANT ALL ON TABLE "public"."categories" TO "authenticated";

GRANT ALL ON TABLE "public"."categories" TO "service_role";

GRANT ALL ON TABLE "public"."expense_shares" TO "anon";

GRANT ALL ON TABLE "public"."expense_shares" TO "authenticated";

GRANT ALL ON TABLE "public"."expense_shares" TO "service_role";

GRANT ALL ON TABLE "public"."expenses" TO "anon";

GRANT ALL ON TABLE "public"."expenses" TO "authenticated";

GRANT ALL ON TABLE "public"."expenses" TO "service_role";

GRANT ALL ON TABLE "public"."scheduled_expenses" TO "anon";

GRANT ALL ON TABLE "public"."scheduled_expenses" TO "authenticated";

GRANT ALL ON TABLE "public"."scheduled_expenses" TO "service_role";

GRANT ALL ON TABLE "public"."v_monthly_member_balances" TO "anon";

GRANT ALL ON TABLE "public"."v_monthly_member_balances" TO "authenticated";

GRANT ALL ON TABLE "public"."v_monthly_member_balances" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

COMMIT;
