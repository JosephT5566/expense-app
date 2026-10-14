# Database and service contracts

This document describes client/service contracts. A captured public-schema baseline, semantic migrations, and synthetic fixtures are checked in. Live schema metadata was inspected on 2026-10-13; real-user authorization and hosted service behavior remain unverified, and the receipt-analysis backend remains external. Types and queries establish what the app expects, but do not verify deployed schema, constraints, RLS policies, or service internals.

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

## Semantic-entry service

Sources: `packages/semantic-entry-contract/src/index.ts`, `services/semantic-entry/semantic_entry/`, and `supabase/migrations/202610120001_semantic_entry.sql`. The public baseline and semantic chain were replayed locally and compared with live metadata on 2026-10-13; the citext trigger fix was applied. See [database evidence](evidence/semantic-entry/2026-10-13-database-baseline.md). This does not verify real production expense transactions or GoTrue/RLS behavior.

- `POST /semantic-entry` accepts `{requestId,text,history?}` with a UUID and 1–500 trimmed Unicode code points of initial text, at most 8 KiB total. History has at most three exact `{question,answer}` pairs, limited to 300/500 trimmed Unicode code points each; text is NFC-normalized and empty history is omitted. The backend verifies the session JWT, checks the allowlist, and uses the same caller JWT for Supabase queries/RPC. Client-supplied identity/hash fields are rejected.
- Eligible input is one whole-TWD expense from 1 through 9,999,999,999, matching the existing `numeric(12,2)` column capacity. Missing date uses the backend Taiwan day; future/invalid dates require correction. Missing scope/payer/currency use personal/current caller/TWD. Category must match an existing expense category; missing, blank or unknown category returns a clarification question and blocks persistence. No fallback category is selected. An empty category list is a terminal configuration error. Personal shares equal the full amount and are settled. Household equal splitting requires at least two known distinct members; email lexical order receives the whole integer remainder in the first member's share. Repairable missing/invalid/ambiguous fields return `needs_input` with one rule-selected question and issues, without an expense write or an extra model call. Unsupported intent, invalid model schema, configuration errors, or unresolved fields after three answers are terminal rejections. Each answer triggers one new extraction using the full bounded history and trusted current context.
- `create_semantic_expense(p_request_id,p_input_hash,p_expense)` returns `{expense,replayed}`. The RPC uses `auth.uid()`, independent payload/allowlist validation, a fixed definer search path, and one transaction for request lock, expense insert, and snapshot storage. Concurrent same-user/key/hash calls replay one result; different hashes conflict. These transaction guarantees are verified only in the disposable fixture.
- `semantic_entry_requests` has primary key `(user_id,request_id)` and stores the input hash plus completed expense snapshot; it has no expense foreign key and no expiry. The server ledger stores no raw description input. Only an unresolved UUID is retained in account-scoped browser storage; text and history remain in modal memory. Hash is SHA-256 of `v1\n` plus trimmed NFC text when history is absent, preserving existing requests. With history it is SHA-256 of `v2\n` plus compact UTF-8 JSON with ordered keys `{text,history}` and ordered turn keys `{question,answer}`. The hash changes with answers and is independent of model version. Retry after an uncertain result must preserve the exact final payload. Edited/deleted expenses do not change the snapshot or permit reinsertion. No automatic cleanup is implemented.
- `semantic_entry_quota` has primary key `(user_id,day)` using the Taiwan day. `consume_semantic_entry_quota()` atomically allows at most 100 new attempts per user/day. Replay precedes quota; each clarification round, rejection, or provider failure can consume an attempt. No new conversation table is added.
- Caller roles cannot directly mutate either table. Owners may read their own snapshots; anonymous RPC access is revoked. Privileged fixture clients exist only in localhost-guarded tests, never runtime or public frontend configuration.
- `GET /semantic-entry/:requestId` returns `completed` or `not_found` after authentication/allowlist checks, without model/quota calls. `not_found` leaves the result uncertain. A timeout or closed browser cannot establish that an accepted SQL operation was cancelled.

POST clients requesting `Accept: text/event-stream; semantic-version=2` can first receive `analysis_delta` (`{requestId,seq,text}`): sequential plain-text fragments of a user-facing Gemini summary, limited to 200 Unicode code points in total. This summary never determines completeness, questions, or writes. Clients without version 2 receive no analysis events. Both versions receive SSE `persisting` (`{status:"persisting",requestId}`), then `result` (the usual created/needs_input/rejected response), or `error` (`{error:{code,uncertain}}`). A question/rejection/replay can return directly without `persisting`. Non-streaming POST remains JSON; GET status remains JSON. Errors before stream acceptance use HTTP JSON errors. Streaming errors after acceptance use events under HTTP 200. The summary is incrementally extracted from Gemini structured JSON; provider thought parts and raw JSON are never forwarded. Complete extraction still passes the same normalizer and fixed-question rules before writing. The response is bounded to 30 seconds, and the frontend permits 32 seconds for transport.

An in-flight service task is retained once the RPC starts, so closing the response stream does not cancel that task within its deadline. Before persistence, disconnection can cancel extraction. Process termination, deadline expiry, or database connection loss still require status recovery; this is not durable background execution or a guarantee of write completion. The frontend blocks ordinary modal closing from submission until a definite response or uncertain error. Page exit cannot guarantee cancellation.

The service extracts through the Gemini Developer API (one structured provider call per round: streamGenerateContent for negotiated analysis and generateContent otherwise, no provider retry), then independently validates before any RPC. Created responses include metadata with token counts or null; Gemini output counts include reported candidate and thinking tokens. Replay metadata describes the current handling and uses null token counts; original usage is not recoverable from snapshots. The UI refreshes current database rows when replaying rather than restoring old snapshot content.

### Actual schema compatibility

The captured schema uses `public.citext[]` for allowed emails and `public.citext` for payer emails. Its existing share trigger now qualifies citext references, allowing invocation under the semantic RPC's empty search path. `expenses.meta` is JSONB with default `{}`. The Supabase adapter serializes non-string JSONB metadata as compact JSON text for both RPC responses and ledger recovery; existing strings stay unchanged, preserving the browser wire contract. Extraction validation limits whole-TWD amounts to 9,999,999,999 to fit `expenses.amount` (`numeric(12,2)`); out-of-range amounts request clarification before persistence. No schema column was changed to accommodate client types. No fallback category configuration is used. The model receives existing expense categories from Supabase and must resolve a valid category before persistence.

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
