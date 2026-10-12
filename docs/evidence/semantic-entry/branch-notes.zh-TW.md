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
