# 2026-10-13：既有資料庫 baseline 與 migration 接管

## 範圍與正式操作結果

本次依用戶指定的專案完成 CLI 連線、schema-only 擷取、既有 migration history 接管，以及已在本機驗證的 trigger 修正。正式操作使用 `/private/tmp/jopie-supabase-production-review`，沒有把 repo 的 disposable test configuration 連到正式資料庫。

最初 remote migration history 為空，但兩張 semantic tables 與兩個 RPC 已存在。兩個 RPC body 與 repo 原 migration 一致，因此沒有重跑建表 SQL。

| Version          | 處理方式                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `20261011000000` | 擷取既有 public schema 的 baseline，確認結構後記錄為 applied；沒有在正式資料庫重建 tables |
| `202610120001`   | 比對既有 semantic objects 後記錄為 applied；沒有重跑原 migration                          |
| `202610130001`   | Dry-run 僅列出這份 trigger 修正，之後透過 `db push --yes` 套用                            |

Baseline 的 version 用於排列在 semantic migration 之前，實際擷取日期是 2026-10-13，不代表在 2026-10-11 曾執行過這份 SQL。兩份原有 schema 的 adopted versions 是透過 `migration repair --status applied` 登錄，不是重新執行 DDL。

## Baseline 的內容與排除項目

新增 `supabase/migrations/20261011000000_existing_public_baseline.sql`，從正式 public schema 的 schema-only dump 整理而成，包含既有 tables、functions、view、indexes、constraints、RLS、triggers、grants 與 default privileges，並補上實際相依的 public `citext`／`pg_trgm` extensions。

Semantic objects 從 baseline 分離，仍由既有 `202610120001_semantic_entry.sql` 建立，避免新環境重建 chain 時重複建表。Baseline 保留既有 SQL 行為，不藉接管 migration 重設權限或改寫業務邏輯。

不包含支出 rows、allowed email 名單、category seed data、session tokens 或 credentials。Supabase 管理的 auth／storage schemas 與 roles 是先決條件，不由 public baseline 重建。本次 metadata 檢查未發現以 public function 實作的 auth／storage custom triggers，也未發現 storage policies；此 public baseline 不宣稱涵蓋所有平台設定。

全新環境仍需另外安全設定 app settings、成員與 categories；不能把正式資料匯出後當測試 seed。

## 重現與修正的 trigger 問題

正式 `sync_expense_shares` 使用未加 schema 的 `citext[]` 與 `::citext`。Semantic RPC 的 definer `search_path` 固定為空，在完整 production-derived schema 的本機測試中，第一次寫入失敗：`type "citext[]" does not exist`。

`202610130001_semantic_trigger_citext.sql` 保留 trigger 本體行為，只把三處型別引用改為 `public.citext`。沒有放寬 RPC 的 search path，也沒有改變分攤規則。修正後，本機 RPC 建立 expense 並透過既有 trigger 同步兩位成員的 `expense_shares`。

## 驗證證據

這些是本次新執行的結果，不是先前 fixture 紀錄的重新引用。

| 檢查                                                  | 結果與範圍                                                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 2.120.0：`migration list`                         | 最初空 history；接管與修正後三個 local／remote versions 一致                                                                                                                                               |
| `db dump --linked --schema public`                    | 擷取 schema-only SQL，留存於 private temporary workspace；沒有匯出應用 rows                                                                                                                                |
| `services/semantic-entry/scripts/baseline-db-test.sh` | 完整 chain 在 localhost disposable PostgreSQL 17 通過；驗證 share trigger、完成結果 replay、hash conflict、拒絕後 rollback、修改／刪除後 snapshot、100 次 quota 上限、ledger owner isolation 與基本 grants |
| Local schema metadata 比對 remote                     | Tables／columns／constraints、RLS policies、triggers metadata 一致；修正前的 application function 差異僅為預期的 trigger fix                                                                               |
| Remote 套用後 metadata 比對                           | 上述 metadata 與 application function body fingerprints 皆符合本機重建結果；不是 production 業務交易驗收                                                                                                   |
| 原有 disposable SQL integration                       | 14 個 tests 通過，使用 synthetic schema／JWTs 與 localhost PostgREST                                                                                                                                       |
| Backend pytest／mypy                                  | 107 個 unit／mock tests 通過；12 個 source files 的 mypy 通過                                                                                                                                              |
| Production dry-run                                    | 接管後僅列出 trigger fix；套用後沒有 pending migrations                                                                                                                                                    |

第一次 schema dump 因暫時 CLI login role 的認證失敗而中止，工具映像下載完成後重試成功。第一次 baseline replay 缺少 `pg_trgm`；依正式 extension metadata 補齊後，完整 chain 成功。這些失敗沒有造成正式 schema replay 或正式 expense 寫入。

本次沒有在正式資料庫執行 expense RPC，也沒有付費模型呼叫。實際 JWT／GoTrue、production RLS 交易行為與 hosted service acceptance 尚未驗證。

## GitHub Actions

新增 `.github/workflows/supabase-migrations.yml`：

- PR 只驗證完整 local migration chain，不使用 production secrets。
- 正式 migration 限 `master` 的手動觸發，預設 `dry_run=true`。
- 指定 `supabase-production` environment；目標 project ref 必須符合此次指定專案。
- 使用獨立 CLI workdir，僅複製 migrations，不帶入 disposable fixtures。
- 先確認 baseline／原 semantic migration 已登錄；不自動 repair history。
- 同一 production migration concurrency group 不並行，也不取消正在進行的操作。
- 明確選擇 `dry_run=false` 才會 `db push --yes`。

既有 semantic verification CI 也加入完整 baseline chain test。Workflow 已建立並做本機 syntax／configuration 檢查，但尚未 push／在 GitHub 執行；本次正式 SQL 是透過本機 CLI 套用。

## 已確認但尚未修正的 service 相容性項目

1. 正式 `expenses.meta` 是 JSONB，RPC 預設回傳 `{}`；目前 Python／TypeScript semantic contract 只接受 string。完整 SQL chain 的本機回傳確認此差異。需要修正 service response adaptation／contract 並加入對應測試，否則可能已完成寫入卻回報結果不明。本次沒有為了配合 client 改動既有 JSONB column。
2. 正式 `expenses.amount` 是 `numeric(12,2)`，其容量小於目前語意規則的 JavaScript safe-integer 上限；正式啟用前需要一致的有效整數金額上限。
3. 只讀檢查未找到名為「其他」的 expense category；`SEMANTIC_OTHER_CATEGORY_ID` 必須明確選定既有 expense category。沒有新增或修改正式 categories。

下一步先處理上述 service contract 差異，再設定 migration workflow environment／secrets，執行授權的 hosted CI 與 service 驗收。部署設定見 [deployment guide](../../semantic-entry-deployment.md#production-migrations)。
