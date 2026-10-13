# 語意記帳 branch 開發紀錄

## 1. 範圍與完成狀態

Branch：`docs/semantic-entry-plan`。紀錄日期：2026-10-12。

本文件整理此 branch 相對本機 `master` 的語意記帳開發，以及本次加入的回詢與串流功能。先前已完成的輪播、收據分析與其他功能不列入本次成果。

目前已完成 repository 內的功能開發、本機驗證與部署流程設定，可以進入部署前驗收。正式資料庫相容性、實際 AI 品質與 hosted service 行為尚未驗證，因此尚未宣告正式上線完成。

本次 Python 遷移與回詢功能開發沒有使用 superpowers plugin；既有設計與計畫檔案仍保留在原本的文件路徑。

## 2. 從文字描述到自動記帳

首頁新增「文字記帳」入口，由獨立 service 解析一筆支出。Service 負責驗證、轉換成既有 expense 資料格式、呼叫 Supabase RPC 寫入，再回傳實際完成的資料。

目前流程為：

1. 用戶輸入一筆支出描述。
2. Service 驗證身分、取得允許成員與分類等 context，並解析描述。
3. 資料不足或可以修正時，回傳具體問題。
4. 用戶補充後，service 重新解析同一筆支出。
5. 資料完整且通過規則時，自動寫入並通知用戶。

沒有草稿確認步驟，也不需要用戶再按一次「確認記帳」。手動編輯與收據匯入仍維持各自流程；收據分析結果仍需要用戶確認後才儲存。

## 3. 共用契約與支出規則

建立 [TypeScript 共用契約](../../../packages/semantic-entry-contract/src/index.ts)，讓前端檢查 request、response、expense row 與 SSE event。Python service 有對應的嚴格驗證器，並透過跨語言測試確認正規化、hash 與回傳格式一致。

目前語意記帳支援一筆正整數台幣支出：

- 日期依台灣時間處理，缺少日期使用後端當天日期。
- 個人支出由目前用戶付款，分攤金額等於總額，標記為已結清。
- 家庭支出需明確列出至少兩位允許成員，支援平均分攤；整數餘數分配給 email 字典序第一位。
- 使用既有分類，不新增分類或成員。
- 退款、多筆支出、排程及其他不支援的意圖會終止處理，不寫入 expense。

詳細欄位與規則以 [service contracts](../../database.md#semantic-entry-service) 為準。

## 4. Backend 從 Node.js 遷移到 Python

Commit `021f110` 完成 backend 遷移。前端保留 Svelte／TypeScript，service 改為 Python 3.12：

| 元件                        | 用途                                       |
| --------------------------- | ------------------------------------------ |
| Starlette／Uvicorn          | HTTP API 與 ASGI server                    |
| Python LangGraph            | 組織驗證、解析與寫入流程                   |
| HTTPX                       | 呼叫模型 API 與 caller-scoped Supabase API |
| `pyproject.toml`／`uv.lock` | 管理與鎖定 Python dependencies             |
| Ruff／mypy／pytest          | 格式、靜態檢查與 backend 測試              |

Docker、smoke harness、fixture evaluation 與 CI 指令同步改為 Python。Container 使用非 root 使用者，僅包含允許的 backend source 與 runtime dependencies，不帶入前端 source、根目錄環境檔或測試 fixtures。

LangGraph 流程保留身分驗證、context、既有完成結果查詢、quota、模型解析、規則驗證與 RPC 寫入的順序。已完成的 replay 先於 quota 與模型呼叫，不會再做一次解析。

## 5. 不保留對話的回詢流程

Request 在原有 `{requestId,text}` 上增加選用的 `history:[{question,answer}]`。每次回詢會沿用同一個 request ID，把回答視為同一筆支出的補充或更正。

- 最多三輪補充回答，亦即初次解析加最多三次後續解析。
- 原始描述與每輪回答最多 500 個去除前後空白的 Unicode code points，問題最多 300；整體 HTTP body 上限仍為 8 KiB。
- 問題由規則選出，不另外呼叫模型生成問題；每次新的解析仍會消耗 quota。
- 缺少金額、付款人不明、分攤成員不足等可修正問題，回傳 `needs_input`。
- 超過補充上限仍無法解析，或遇到不支援意圖、schema／設定問題時，終止處理。

對話只存在 modal 記憶體，關閉、切換帳號、離開頁面或重新載入後即捨棄。沒有新增 conversation table、graph checkpointer 或獨立 AI agent endpoint。對話內容是未信任的資料，不能覆寫後端提供的成員、分類或驗證規則。

## 6. SSE 寫入通知與 modal 關閉限制

沿用 `POST /semantic-entry`，前端以 `Accept: text/event-stream` 要求 SSE；一般 JSON POST 仍保留，結果查詢 GET 仍使用 JSON。

| Event        | 用途                                        |
| ------------ | ------------------------------------------- |
| `persisting` | 完成規則驗證後、呼叫寫入 RPC 前發送         |
| `result`     | 回傳 `needs_input`、`created` 或 `rejected` |
| `error`      | 傳達錯誤與結果是否仍不確定                  |

這是 service 狀態串流，不是模型 token 串流。回詢、拒絕或 replay 可直接回傳結果，不一定經過 `persisting`。

前端從每次送出開始鎖定 Close、Escape 與外部點擊，避免寫入通知尚未抵達前用戶關閉 modal。收到回詢、完成或錯誤後解鎖；寫入期間顯示「正在記帳」。完成通知顯示儲存結果的描述、金額、日期與分攤。

SSE 連線中斷後，已開始寫入的 in-flight task 會在自己的期限內繼續執行。這不是 durable background job：service process 終止、instance shutdown、逾時或資料庫連線中斷仍可能讓結果不明，需要查詢恢復。HTTP 操作期限為 30 秒，前端等待上限為 32 秒；正式環境的 proxy buffering 與中斷行為仍需驗收。

## 7. Idempotency、quota 與隱私

前端產生 UUID 作為 request ID，同一筆回詢沿用該 ID。既有 draft RPC 以 `(user_id,request_id)` 與 input hash 控制寫入；同用戶、同 key、同 hash 重播既有結果，不同 hash 則衝突。

未帶 history 的 hash 保留原本 v1 格式；帶 history 的 v2 hash 覆蓋正規化後的完整描述與問答。結果不確定時，重試必須保留完全相同的 payload，不能改回答後使用同一 key 重試寫入。

恢復機制改為：

- 每次送出前，只在帳號範圍的 localStorage 保存 `{requestId}`。
- 對話、原始描述、JWT 不寫入 pending storage；舊格式只取 UUID，再改寫為最小紀錄。
- Payload 尚在 modal 記憶體時可以重試；關閉或重新載入後僅提供結果查詢。
- `not_found` 不是失敗證明；後續錯誤也不能抹除先前的不確定性。
- Service structured logs 不含原始描述、問答或 token。

此 branch 建立的 draft SQL 已包含 request ledger 與每日 quota table；「不新增 conversation table」不表示完全沒有 service tables。每日 quota 上限為每用戶 100 次新嘗試，依台灣日期計算。

SQL 交易、授權與防重複效果僅有 disposable fixture 證據，不能推論 production schema／RLS 已相容。本次回詢改動沒有新增或修改 SQL migration。

## 8. 前端狀態與 replay 資料更新

新增處理中、回詢中、寫入中、完成、拒絕、錯誤與結果不明等狀態。帳號與 request revision guards 避免舊回應寫入新帳號的 UI。

Service 完成寫入後，前端更新既有 expense store／cache，不再透過 expense REST API 重複新增。Replay 時重新讀取目前資料，避免把已修改或刪除的 expense 用舊 snapshot 蓋回去。

此 branch 同時修正 monthly force refresh，以分頁讀取並替換該月份的 store／cache 資料，納入刪除與超過 500 筆的情境。這是一般分頁讀取，不宣稱具備資料庫 snapshot 一致性。

## 9. 測試、CI 與證據範圍

下表整理回詢功能完成時的驗證紀錄。本次撰寫 note 的階段只新增文件與文件連結，沒有重新跑所有應用測試；詳細指令與結果在 [implementation plan](../../superpowers/plans/2026-10-11-semantic-expense-entry.md#repository-verification--2026-10-12)。

| 驗證                      | 紀錄結果與範圍                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Python pytest             | 107 個 unit／mock tests 通過；不包含預設排除的 SQL integration                           |
| Ruff／mypy                | 通過，mypy 檢查 12 個 backend source files                                               |
| Python／TypeScript parity | 16 個 request／hash cases、5 個 synthetic JSON HTTP responses、3 個 ASGI SSE events 通過 |
| Fixture evaluation        | 40 個 cases、120 次 observations、零失敗、零付費呼叫；不代表真實模型品質                 |
| Docker build／smoke       | 通過，synthetic dependencies 下驗證 Uvicorn、history、SSE 與基本 HTTP 行為               |
| 前端 `npm run check`      | 0 errors、6 個既有 warnings                                                              |
| Playwright semantic specs | 根目錄 26 個、`/expense-app` 子路徑 26 個通過；包含本機分段 HTTP SSE 與 modal 鎖定       |
| 格式與 lint               | 修改範圍通過；整個 repo 的 `npm run lint` 被既有 122 個檔案格式問題阻擋，未宣稱全域通過  |
| Disposable SQL            | Python 遷移階段紀錄為 14 個 tests 通過；本次 SQL 未改、未重跑，屬歷史 fixture 證據       |

[證據索引](README.md) 保留原始 Node 實作與 Python 遷移的歷史數據。不同階段的測試數量不應混合當作單次驗證。

新增 verification CI 與手動 Cloud Run release workflow，使用 synthetic frontend configuration；部署 workflow 限制於 `master`，透過 OIDC 取得權限，未自動套用 production SQL。Workflow 設定已在 repository，但 hosted GitHub 執行結果尚未驗證。

## 10. 文件與提交里程碑

更新 README、架構、service contracts、部署指南、實作計畫與 evidence，讓 Python 指令、回詢、SSE、UUID-only recovery 與正式環境邊界有一致描述。

| 已有 commit | 內容                                   |
| ----------- | -------------------------------------- |
| `fab8862`   | 語意記帳設計、計畫與驗證方向           |
| `7a9de1a`   | 共用契約與自動記帳規則                 |
| `2bce22a`   | Draft Supabase idempotency／quota RPC  |
| `f658666`   | LangGraph service                      |
| `9b585cb`   | 無確認步驟的前端自動記帳               |
| `7ed1984`   | 測試證據與 Cloud Run release 設定      |
| `90938d0`   | Pending request 重試與頁面生命週期恢復 |
| `ee5e6c3`   | 開發交接紀錄                           |
| `021f110`   | Python backend 遷移                    |

本 note 與回詢、SSE、UUID-only recovery 的修改一起提交，形成此 branch 的下一個里程碑。

## 11. 下一步與尚未驗證項目

1. 授權 push／PR 後，讓 hosted verification CI 實際執行，確認 Linux Supabase bootstrap 與 workflow 行為。
2. 比對正式 Supabase schema、RLS、triggers、grants 與 fallback category，完成 draft migration 的 production 相容性確認。
3. 準備 Cloud Run／Secret Manager／OIDC／IAM 與 frontend endpoint 設定，再執行授權部署。
4. 使用真實授權帳號測試回詢修正、寫入中斷線、同 key 重試、replay、跨帳號隔離與 SSE buffering。
5. 經授權後進行實際模型評估，記錄品質、延遲、token usage 與費用；目前沒有付費模型驗收證據。

目前沒有 operator-reported 的正式環境成功結果。本次工作未 push、merge、部署、修改 production SQL／IAM 或呼叫付費模型。設定與上線步驟見 [部署指南](../../semantic-entry-deployment.md)。

## 12. 後續更新：2026-10-13 資料庫 migration 接管

已登入 CLI 並完成既有 public schema baseline、migration history 接管及 citext trigger 修正。新增完整 schema chain 的本機測試與手動 migration Action。前述 2026-10-12 的「尚未操作 production SQL」與「尚無正式 schema 證據」是當時的歷史紀錄；最新範圍、操作結果與 service 相容性待辦見 [資料庫接管紀錄](2026-10-13-database-baseline.md)。

## 13. Service 與實際 schema 對齊

Supabase adapter 在建立結果與 ledger 查詢復原時，將 JSONB `meta` 轉成 compact JSON 字串，保留前端既有 contract；既有字串原樣保留。解析驗證限制台幣整數金額為 1 到 9,999,999,999 元，超過上限會回詢並且不進入 RPC。此階段沒有新增 migration 或正式資料庫操作。Backend unit tests、Ruff 與 mypy 的最新結果見 [相容性驗證](2026-10-13-service-schema-compatibility.md)。

## 14. 成員名稱改由 GitHub environment 設定

部署 workflow 改讀 `semantic-entry-production` 的 `SEMANTIC_MEMBER_NAMES` variable，驗證 email-to-name JSON object 後，透過 runtime env file 注入 Cloud Run。Mapping 不再需要 Secret Manager secret，也不會寫入 image；修改 variable 後需要重新部署才會生效。模型 API key 仍使用 Secret Manager。此變更沒有執行 hosted deployment，Gemini provider 尚未實作。

本次 repository verification：workflow YAML、內嵌 Bash／Python syntax 通過；使用 synthetic mapping 驗證中文、引號、逗號與換行經 JSON env file 完整保留，空 object 合法，無效 JSON／array／null／非字串 value 被拒絕。Prettier 與 `git diff --check` 通過。Backend／frontend／container 未改動，未重跑其測試；Cloud Run secret-to-env 切換仍待 hosted 驗收。

## 15. 分類未確認時回詢，不使用預設分類

分類缺失、空白或不屬於既有 expense categories 時，service 會回詢並阻止寫入。使用者補充後解析出有效既有分類，才進入原本的自動寫入流程。沿用最多三輪回答，仍未解決則拒絕並不寫入；category list 為空則屬於設定錯誤。Prompt 明確禁止自動選其他／預設分類，版本改為 `semantic-entry-v3`。移除 context fallback 與部署設定 `SEMANTIC_OTHER_CATEGORY_ID`，不需要 database migration。先前章節提及 fallback 的內容為歷史紀錄。

本次 repository verification：

- `uv run --directory services/semantic-entry --locked pytest`：120 passed，包含分類缺失／空白／未知時零寫入、回答後有效分類才寫入、三輪後仍缺分類拒絕；fixture evaluation 仍為 40 cases、120 observations、0 paid calls，依新分類規則更新 authored outputs。
- `uv run --directory services/semantic-entry --locked ruff check .`、`ruff format .` 與 `mypy`：通過。使用既有 `/tmp/jopie-uv-cache`、`/tmp/jopie-uv-python`。
- `npm run check`：0 errors、6 existing warnings。`npm run lint`：123 個 Prettier 格式問題中包含本次 fixture，已格式化修正；其餘 122 項為既有問題，whole-repository lint 未通過。Changed-file Prettier 與 contract ESLint 通過。
- Docker build 與 `services/semantic-entry/scripts/container-smoke.sh`：通過；model／database 為 synthetic dependencies。
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/jopie-playwright PUBLIC_SEMANTIC_ENTRY_URL=https://semantic.example.test npm run test:e2e -- e2e/semantic-entry.test.ts`：26 passed。第一次未指定本機 browser path，因預設 browser executable 缺失導致 26 tests 無法啟動，使用既有 browser 安裝後重跑成功。
- Workflow YAML／Bash／Python syntax、synthetic runtime config（不設定 fallback）、Markdown local links、`git diff --check`：通過。

沒有修改 SQL，未重跑 SQL integration；沒有 routing 變更，未重跑 subpath E2E。Mocked tests 不驗證 production RLS 或模型分類品質。本次未部署、未執行 production expense transaction，也未修改 Gemini provider。

## 16. Gemini provider

原有分類回詢與 member-name env 設定已 commit 為 `dbfc872`。Service 改用 Gemini Developer API REST generateContent，API key 只放 header；預設 `gemini-3.5-flash-lite`，模型可由 `SEMANTIC_MODEL` 選擇支援的 Flash identifiers。既有 schema 經 responseFormat 提供，僅完整 STOP text output 可解析；safety block、截斷、非 JSON、工具回應等皆停止且不進入寫入。保留 15 秒 deadline、800-token generation cap、單次呼叫無 retry。Usage 轉為原有 wire metadata，output 包含回傳的 candidate／thinking tokens。

部署改讀 `SEMANTIC_GEMINI_SECRET`，綁定 `GEMINI_API_KEY`；live evaluation 同步修改。Member mapping 仍為一般 env，沒有新增 SQL 或 frontend contract 變更。Application tracing 關閉不代表 Gemini 平台資料保留政策，實際模型品質與 hosted secret 注入仍需另外授權驗收。

本次 repository verification：133 backend tests passed；Ruff check／format 與 mypy（12 source files）通過。新增 Gemini request/header/schema、STOP output、safety refusal、MAX_TOKENS、malformed JSON、tools、多候選、分段 text／thought 排除、usage、HTTP 401／429／500 不 retry、invalid model 不出網路與 runtime env wiring 測試。Fixture CLI 40 cases／120 observations／0 paid calls／0 failures。Docker build 與 localhost synthetic container smoke 通過。Workflow YAML／Bash／Python syntax 與 synthetic model/runtime config 通過；secret-binding inspection 初次因測試程式使用錯誤 step index 而失敗，改依 action 名称選取後通過。Changed-file Prettier、Markdown links、`git diff --check` 通過。

本階段僅 backend provider／部署 workflow／文件改動，未重跑 frontend、SQL integration；前階段的 26 Playwright tests 是歷史結果。沒有 hosted deployment、付費 Gemini call 或正式 expense 寫入。Gemini key 的模型權限、schema 接受度、延遲與真實解析品質均為 unverified，下一步建立 Gemini key secret 並完成授權的 hosted／live 驗收。舊 OpenAI 與 member-name secrets 移除前需確認其他服務／revision 沒有引用。

Operator-reported：使用者已完成 GCP 設定與 GitHub variables。此狀態尚未獨立核對 IAM、secret version、OIDC 或實際 variable 值；不視為 hosted deployment／驗收完成。下一步將 branch 整合至 master 後執行手動部署 workflow，確認驗證、OIDC、image push、secret 綁定與 health check，再安排授權的真實登入與寫入驗收。

## 17. CI E2E fixture 與互動同步修正

使用者回報 Semantic Entry Check 在 replay deletion reload 與 processing outside-click 兩個案例失敗（CI log 為 operator-reported）。原本兩個案例在本機各重跑五次，10 passed，未直接重現 CI 失敗。Source inspection 找到兩個可造成結果依執行順序變動的測試條件：expense mock 忽略 PostgREST 的 `ts` gte/lte，導致同一筆 October expense 也能被存入 September cache；Bits UI outside pointerdown callback 有 10ms debounce，測試會在 callback 執行前釋放 completion response，callback 就可能在 modal 已完成後執行。

修改僅限 `e2e/semantic-entry.test.ts`：mock 先按實際日期篩選再分頁；刪除案例直接檢查 October／September IndexedDB cache，確認 replay 後與 reload 後 October 為空；outside-click 案例透過 Playwright clock 執行 pending callback 後才釋放回應。沒有延長 expect timeout、加入測試 retry 或修改應用程式。

Repository-verified：使用 CI 的 synthetic PUBLIC env，`npm run test:e2e -- e2e/semantic-entry.test.ts e2e/daily-carousel.test.ts --workers=2 --repeat-each=2` 為 58 passed（兩輪 29 tests），browser path 使用 `/tmp/jopie-playwright`。`npm run check` 為 0 errors／6 existing warnings；`npm run lint` 在 Prettier 階段失敗，122 個既有格式問題，未進入 whole-repository ESLint。Changed-file ESLint 與 Prettier 通過。Backend／SQL／container 未修改，未重跑其 checks。新的 GitHub Linux run 尚未執行，需推送修正後重跑 CI 確認。

Pages base path verification：同一組 synthetic env 加上 `BASE_PATH=/expense-app E2E_BASE_PATH=/expense-app`，執行 `npm run test:e2e -- e2e/semantic-entry.test.ts --workers=2` 為 26 passed（同一 spec 依 Playwright 設定實際使用 1 worker）。這是本機 mocked browser 證據，並非 GitHub hosted run。
