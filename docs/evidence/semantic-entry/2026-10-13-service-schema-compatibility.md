# 2026-10-13：Service schema 相容性修正

## 修改內容

延續 [資料庫接管紀錄](2026-10-13-database-baseline.md) 發現的差異，在 service 端完成以下調整：

- `SupabaseAdapter` 在 create RPC response 與 completed ledger lookup 都透過同一個 adapter 處理 `meta`。非字串 JSONB 值以 compact JSON 字串回傳，包含 `{}`、array、number、boolean 與 JSON null；既有字串保持原值。Missing `meta` 仍屬於無效 row。原始 database payload 不會被修改。
- 前端 wire validator 與 `ExpenseRow.meta: string` 保持原本契約，沒有改動既有資料庫 JSONB column。
- `normalize_extraction` 限制正整數台幣金額為 1 到 9,999,999,999 元，符合既有 `numeric(12,2)` 容量。超過上限視為 amount invalid，依既有回詢次數規則要求修正；不呼叫 persist RPC。回詢文字包含上限。
- 沒有修改已套用 migration，也沒有新增 migration。

來源：`services/semantic-entry/semantic_entry/supabase.py`、`normalize.py`、`clarification.py`；前端契約仍位於 `packages/semantic-entry-contract/src/index.ts`。

## Repository-verified

本次執行，使用 `UV_CACHE_DIR=/tmp/jopie-uv-cache` 與 `UV_PYTHON_INSTALL_DIR=/tmp/jopie-uv-python`，避免預設 cache 目錄的 sandbox 存取限制：

| Command                                                                     | Result                       |
| --------------------------------------------------------------------------- | ---------------------------- |
| `uv run --directory services/semantic-entry --locked pytest`                | 116 passed                   |
| `uv run --directory services/semantic-entry --locked ruff check .`          | Passed                       |
| `uv run --directory services/semantic-entry --locked ruff format --check .` | 22 files formatted           |
| `uv run --directory services/semantic-entry --locked mypy`                  | No issues in 12 source files |

新增測試涵蓋 JSONB 預設 object、巢狀中文資料、array、JSON null、number、既有 string 的建立／復原結果，以及個人／家庭金額邊界與超額回詢不寫入。Adapter 使用 HTTP mocks；這些結果不代表 hosted Supabase HTTP、GoTrue 或 RLS 已驗收。

本次只修改 backend 與文件，沒有修改 frontend 或 SQL，因此沒有重跑前端 E2E、SQL integration 或 container build。Migration commit 前另有重新執行完整 disposable baseline chain 並通過。未呼叫付費 model 或執行正式 expense 寫入。

## 下一步

設定並核對既有 expense category 的 `SEMANTIC_OTHER_CATEGORY_ID`，完成部署設定與授權後，再進行 hosted authentication、建立／回詢、斷線後 GET 復原及實際 RLS 驗收。此任務尚未部署或 push。
