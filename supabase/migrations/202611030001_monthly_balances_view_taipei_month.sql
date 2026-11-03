-- Bucket v_monthly_member_balances owed amounts by the Asia/Taipei month.
-- The baseline view truncated paid rows by (ts AT TIME ZONE 'Asia/Taipei') but
-- owed rows by date_trunc('month', ts), which follows the session time zone
-- (UTC on Supabase). An expense between 00:00 and 08:00 Taiwan time on the
-- first day of a month therefore had its paid amount in the new month and its
-- owed amount in the previous month, splitting net across two months.
-- Only the owed branch's month expression changes. Columns, names, order,
-- types, security_invoker, and ORDER BY are unchanged, so CREATE OR REPLACE
-- VIEW keeps the existing owner and grants; no GRANT/OWNER statements needed.
-- Verified on a disposable local database only. Applying this to production
-- requires the owner's review and must be run by the owner.
BEGIN;

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
         SELECT ("date_trunc"('month'::"text", ("e"."ts" AT TIME ZONE 'Asia/Taipei'::"text")))::"date" AS "month",
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

COMMIT;
