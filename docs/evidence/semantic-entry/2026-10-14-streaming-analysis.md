# Gemini 串流分析驗證 — 2026-10-14

分支：`feat/semantic-entry-streaming-analysis`。本次保留程式 normalize、固定追問與自動寫入，新增 Gemini analysis＋extraction envelope、上游 SSE、版本協商及前端分析純文字。未執行付費模型呼叫、正式資料庫操作、push、merge 或 deploy。

## Repository-verified

| 實際命令／檢查                                                                                                                                                                                                 | 結果與範圍                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uv sync --project services/semantic-entry --locked`                                                                                                                                                           | 57 packages resolved，鎖定環境一致                                                                                                                                                                 |
| `uv run --directory services/semantic-entry --locked pytest`                                                                                                                                                   | 最終 187 passed；含實際 localhost Uvicorn／HTTPX 分段到達、寫入前斷線取消、寫入後查詢恢復及滿佇列回歸測試                                                                                          |
| `uv run --directory services/semantic-entry --locked ruff check .`                                                                                                                                             | 通過                                                                                                                                                                                               |
| `uv run --directory services/semantic-entry --locked ruff format --check .`                                                                                                                                    | 27 files already formatted                                                                                                                                                                         |
| `uv run --directory services/semantic-entry --locked mypy`                                                                                                                                                     | 13 source files 無問題                                                                                                                                                                             |
| `uv run --directory services/semantic-entry --locked python -m semantic_entry.evaluation --mode fixture --out /tmp/jopie-streaming-fixture-eval`                                                               | 40 case IDs、120 observations、0 failures、0 paid calls；測 authored extraction／normalizer，不代表模型品質                                                                                        |
| `node --experimental-strip-types packages/semantic-entry-contract/tests/python-parity.mjs`                                                                                                                     | 16 requests、5 HTTP responses、6 SSE events；另含 malformed analysis UUID／seq／文字／extra key 拒絕 assertions                                                                                    |
| `docker build -f services/semantic-entry/Dockerfile -t jopie-semantic-entry .`                                                                                                                                 | 通過，包含 reviewed lifecycle fix                                                                                                                                                                  |
| `services/semantic-entry/scripts/container-smoke.sh`                                                                                                                                                           | `/health`、合成 POST／GET／SSE 及 v1／v2 通過；v2 analysis 在 persisting／result 前，沒有 live DB／Gemini                                                                                          |
| `npm run check`                                                                                                                                                                                                | 0 errors，6 個既有 warnings：Carousel、ExpenseDrawerContent、layout 的 initial-state references                                                                                                    |
| `npm run lint`                                                                                                                                                                                                 | **失敗**，Prettier 在 122 個既有檔案發現格式問題，ESLint 因 `&&` 未執行。包含 `.prettierrc`、`.vscode/settings.json`、`src/app.html`、既有 shadcn components／routes／stores；本次沒有擴大範圍修復 |
| Changed-file ESLint：`npx eslint src/lib/data/semantic-entry.fetcher.ts src/lib/components/semantic-entry/SemanticEntryDialog.svelte packages/semantic-entry-contract/src/index.ts e2e/semantic-entry.test.ts` | 通過；不等同全 repository lint 通過                                                                                                                                                                |
| `npm run test:e2e -- e2e/semantic-entry.test.ts`                                                                                                                                                               | 根路徑最終 38 passed                                                                                                                                                                               |
| `BASE_PATH=/expense-app E2E_BASE_PATH=/expense-app npm run test:e2e -- e2e/semantic-entry.test.ts`                                                                                                             | GitHub Pages 子路徑最終 38 passed；此命令重建 subpath assets 並驗證導航／session 與合成記帳流程                                                                                                    |
| Changed-file Prettier、source／Markdown links、`git diff --check`                                                                                                                                              | 通過                                                                                                                                                                                               |

E2E 使用 synthetic Supabase URL／publishable key、synthetic session 與 `https://semantic.example.test`，Playwright Chromium 安裝在 `/tmp/jopie-playwright`。模型串流與 transport tests 使用合成依賴；沒有讀取 private receipts／expense data。

驗證界線：同一 extraction 的固定問題與 expense 不變；分析不能覆寫 amount=null；replay 不重新呼叫模型；前端驗證 UUID、seq、200-code-point 總量、事件順序及 EOF，summary 不存入 history／storage。涵蓋 HTML 文字不執行、每輪／新操作／帳號／pagehide／status query 清理及結果待確認。

## 修正及執行中的失敗

新測試先觀察 RED 再實作。Whole-branch reviewer 發現滿佇列 persisting signal 在 enqueue 前被標為 writing，斷線後可能保留尚未呼叫 RPC 的 task；已用回歸測試重現，改為 signal 入列後才標記，並在斷線時釋放 queue、timeout 非阻塞傳送 terminal error。Queue 滿且出錯時只丟棄待送分析，保留 writing／error 訊號。

Reviewer 同時指出第一個 result 之後的事件未被檢查；已重現 trailing analysis／second result 被誤判成功，改為完整終止／EOF 檢查，異常維持 uncertain recovery。Focused review 沒有剩餘 blocking code finding。

Focused reviewer 的 cold-process test 曾因 10ms test deadline 在 graph 初始化時耗盡而失敗；改以明確 full-queue 同步及較長測試時限驗證，最後 targeted 2 passed、whole suite 187 passed。這只調整測試，不更動 production deadlines。

另外 task ledger 的第一次 pytest 從 repository root 執行，誤包含尚未設定 fixture 的 DB integration tests，出現 14 setup errors；改為 service cwd 後套用正確預設排除。一次 sandbox transport run 因 localhost socket bind 權限失敗，允許 socket access 後通過。首次 browser run 缺 Chromium，安裝至 `/tmp` 後通過。這些失敗不被當作通過，也沒有連線至正式 DB。

完整合成 log 與 ledger 另保存在本機 `/tmp/jopie-streaming-analysis-verification.zip`，用於診斷；不加入目前 setup／architecture 文件作為持續有效的測試結果。

## Unverified 與下一步

Gemini key／指定模型接受新的 schema、analysis＋extraction 在 800 output tokens 內的完成率、實際 token／費用、首段延遲，以及 Cloud Run 的端到端 buffering／instance termination 均未由本次 live call 驗證。現有 Supabase 交易／GoTrue／RLS 部署行為沒有因這些 mock 測試獲得新的正式環境證據。

本次沒有 SQL 或 carousel 變更，因此沒有另跑 DB integration／daily-carousel tests。沒有依據 mock 結果宣稱正式資料庫寫入成功。

下一步：審閱／整合分支後，在另外授權的 hosted acceptance 範圍使用合成輸入確認 Gemini schema、串流延遲／斷線及真實 token usage；部署與前端 release 需各自執行。現有 Cloud Run 部署 workflow 僅從 master 手動觸發。

參考：[設計](../../superpowers/specs/2026-10-14-gemini-streaming-conversation-design.md)、[實作計畫](../../superpowers/plans/2026-10-14-gemini-streaming-analysis.md)、[Service contracts](../../database.md#semantic-entry-service)、[部署](../../semantic-entry-deployment.md)。
