# Database and service contracts

This document describes frontend contracts. No SQL definitions, migrations, or receipt-analysis backend are checked in. Types and queries establish what the app expects, but do not verify deployed schema, constraints, RLS policies, or service internals.

## Expenses

Sources: `src/lib/types/expense.ts`, `src/lib/data/expenses.fetcher.ts`, and `src/routes/settle/+page.svelte`.

The app reads and writes `expenses`, identified by `id`. Its row contract includes payer email, note, amount, currency, timestamp (`ts`), scope, shares, category, settlement status, metadata, and creation/update timestamps. Optional `notes` and `category_id` are declared in the type.

- `scope` is `personal` or `household`.
- `shares_json` maps member email to a monetary share, rather than an unconverted percentage.
- `payer_email` identifies who paid the full amount.
- `is_settled` tracks settlement status; it does not record a payment transaction.
- `currency` supports values in the `Currency` type. The manual editor currently submits `TWD`. Settlement sums amounts without currency conversion or currency partitioning.

For selected household rows, settlement computes each member's net as **paid amount minus owed shares**. Positive balances receive money; negative balances pay. The UI proposes transfers rounded to integers and can mark selected expenses settled.

## Scheduled expenses

Sources: `src/lib/types/expense.ts` and `src/lib/data/scheduled-expenses.fetcher.ts`.

`scheduled_expenses` includes `id`, owner and payer emails, expense details, `scheduled_for`, timezone, recurrence fields, status, optional created-expense ID, and creation/update timestamps. Listing filters by the current user's `owner_email`.

| Field                  | Frontend contract                                             |
| ---------------------- | ------------------------------------------------------------- |
| `kind`                 | `one_time` or `recurring`                                     |
| `status`               | `pending`, `confirmed`, or `cancelled`                        |
| `recurrence_rule`      | `daily`, `weekly`, or `monthly` for recurring rows            |
| `recurrence_weekday`   | Integer 0–6 for weekly recurrence                             |
| `recurrence_month_day` | Integer 1–31 for monthly recurrence                           |
| `timezone`             | Defaults to `Asia/Taipei`; recurrence rejects other timezones |

Approval requires a due, pending row. The client creates an expense at the scheduled timestamp, then deletes a one-time schedule (returning a synthetic confirmed row), or advances a recurring schedule and records the expense ID. Recurring rows stay pending for the next occurrence.

Cancelling a one-time row sets its status to cancelled. Cancelling a recurring occurrence advances its date while keeping it pending. Monthly recurrence clamps the selected day to the last day of the next month.

Approval uses separate Supabase requests, not a transaction or RPC. If schedule deletion/update fails after expense creation, the expense has already been written; atomic or idempotent approval is not guaranteed by this client.

## Categories and settings

- `categories` is queried by `src/lib/data/categories.fetcher.ts`, ordered by `sort_order`, and optionally filtered by `kind`. Its type declares `id`, `name`, and `kind` (`expense` or `income`); startup requests expense categories.
- `app_settings` is queried by `src/lib/data/appSetting.fetcher.ts` for the singleton row where `id = true`. Its contract contains `allowed_emails: string[]`.
- Member names and colors use `PUBLIC_EMAIL_NAME_MAPPING` as well as session metadata; see [setup](../README.md#development).

## Receipt-analysis service

Sources: `src/lib/data/ai-receipt.fetcher.ts`, `src/lib/types/ai-receipt.ts`, and `src/lib/components/ai-receipt/UploadStep.svelte`.

Both actions POST JSON to `PUBLIC_GOOGLE_AI_GCF` with `Authorization: Bearer <Supabase session access token>`:

| Action            | Request fields                                    | Expected response                                                |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `get_upload_url`  | `files` containing `file_name` and `content_type` | `uploads` with `file_name`, signed `upload_url`, and `file_path` |
| `analyze_receipt` | `file_paths`                                      | `ReceiptAnalysisResponse` in `src/lib/types/ai-receipt.ts`       |

The UI uploads image bytes directly to signed URLs before analysis. Frontend limits are four images, 10 MiB per image, and 20 MiB total. JPEG, PNG, and WebP are accepted, with HEIC/HEIF conversion on the client.

The adapter handles normalized data and validation outcomes. Extraction fields distinguish recognized values, unrecognized values, explicit null, and omitted fields; preserve these distinctions when changing the adapter or preview UI. Saving reviewed expenses is a separate Supabase bulk upsert after user confirmation.

## Inherited Supabase notes

These notes were moved from the original README. They describe intended external database design and have not been verified against deployed SQL. Current frontend settlement uses `expenses.shares_json` directly.

### Shares table and trigger

`public.expenses` 紀錄每一筆消費的原始資訊：`payer_email` 是付錢的人，`shares_json` 儲存分攤資料，方便前端一次性寫入。依目前前端 contract，分攤值為金額。

`public.expense_shares` 透過 Trigger (`trg_sync_shares`) 自動從主表的 `shares_json` 展開，將 JSON 攤平成資料列，以便進行 SQL 聚合運算（如 SUM、GROUP BY）。

原 README 記載 `uuid` 為 unique value，`expense_id` 對應主表識別碼；若有兩位參與用戶，同一 `expense_id` 會有兩筆分攤資料。這些從表欄位未在目前前端程式碼中定義；主表前端識別欄位使用 `id`，實際 SQL 欄位需另外確認。

### Security and RLS

原 README 記載使用 Supabase Row Level Security，透過自定義函數 `email_allowed()` 檢查目前使用者是否在 `app_settings` 的白名單內。實際 policies、函數及其覆蓋範圍需從 Supabase 驗證；前端 query filters 不能取代 RLS。

### Monthly balance view

原 README 記載 `v_monthly_member_balances` 使用 **SECURITY INVOKER**，遵循底層 table 的 RLS，透過 CTE 和 `UNION ALL` 計算 `Net = sum(Paid) - sum(Owed)`：

1. Paid 來自 `expenses`，將整筆金額歸給 `payer_email`。
2. Owed 來自 `expense_shares`，JOIN 回主表取得月份與分類，將分攤金額歸給 `user_email`。

目前 repository 沒有此 view 的 SQL，也沒有查詢此 view 的前端呼叫。
