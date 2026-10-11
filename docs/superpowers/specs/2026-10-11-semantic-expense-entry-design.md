# 語意記帳與 Product Harness Evidence 設計

更新：2026-10-12。使用者已同意採用 GCP 後端執行流程、Supabase HTTPS RPC 保證冪等寫入的方向；本文件尚未代表實作、migration 或部署完成。預設值、驗收門檻與具體 interfaces 是實作前可 review 的規格。

## 目的與範圍

登入使用者送出一段繁體中文文字後，系統自動解析、驗證並新增一筆支出；沒有草稿確認、追問或其他人工介入。第一版只支援單筆、正整數 TWD 支出，包含個人／家庭支出與明確成員均分。外幣、退款、未來支出、多筆、語音、支出問答、排程與其他分攤方式不在範圍內。無法可靠判定時結束並顯示原因，不新增、不猜金額。

## 使用流程與預設值

首頁「文字記帳」入口輸入語句，按「送出記帳」即授權新增。顯示處理中、已新增、未新增或結果待確認；成功後沿用既有 expense store/cache 更新，使用者可透過既有手動入口編輯／刪除。

- 缺少日期：台灣今天；今天／昨天／前天依後端時鐘解析，不受瀏覽器時區或首頁選取日期影響。絕對日期必須是有效且不晚於今天的 YYYY-MM-DD。
- 缺少付款人：登入者；「我」由已驗證身分解析。明確未知或同名付款人拒絕。
- 缺少幣別：TWD；明示其他幣別拒絕。
- 無共同分攤語意：個人支出；有共同語意但成員不明則拒絕。「兩人平分」僅在授權成員恰好兩人時成立。
- 分類未匹配：使用後端 SEMANTIC_OTHER_CATEGORY_ID 指定、且存在於 expense categories 的「其他」類別；未配置或無效時 fail closed，不憑空新增分類。
- 缺少／無效金額、空白描述、歧義或未支援需求：拒絕，不追問、不写入。

均分按成員 email 字典序排列，每人 floor(amount / n)，餘數歸第一位。個人付款人必須為登入者，shares_json 為其全額；家庭分攤總和必須等於 amount。個人 is_settled=true，家庭=false。新 expense 的 ts 使用台灣該日 00:00:00 的 ISO timestamp。既有手動記帳行為不變。

## 架構與權限

GitHub Pages → GCP Cloud Run 的 Node.js 22 container → LangGraph → Supabase HTTPS Data API/RPC。Cloud Run 是 serverless container，使用 request-based billing、min instances=0；第一版同步短流程，不新增 Cloud SQL、Redis、queue 或 LangSmith 託管部署。LangGraph 使用 library 與自己的 HTTP handler，不部署完整 Agent Server；不啟用 memory checkpointer 假裝提供跨重啟恢復。

Graph 節點為 authenticate → context → replay lookup → quota → extract → validate → persist → result。reject/error 分支不執行 persist。使用一次結構化模型呼叫；沒有人工 interrupt、任意資料庫工具或模型自行決定 SQL。

Cloud Run 驗證 Supabase access token 後，以 publishable key + 使用者 JWT 建立 caller-scoped client。context 從 app_settings、categories、後端 member name mapping 取得，不接受 request 指定 user/email/category context。寫入 RPC 取得 auth.uid()；不得用前端 user_id 代替 verified identity。GCP 不需要 PostgreSQL password、直接資料庫連線或 connection pool。若未來採 privilege-elevated RPC，必須固定 search_path、限制 grants 並明確驗證身分和 allowlist；service-role 不是預設 runtime credential。

## Request、結果與冪等契約

POST /semantic-entry request 為 `{requestId:UUID,text:string}`，trim 後 1–500 Unicode code points，body <=8KiB。前端在一次新操作建立 UUID；timeout／重送沿用相同 UUID 與相同文字，使用者主動建立另一筆才換 UUID。Idempotency input hash 由後端對 `v1\n` + trim/NFC-normalized text 計算 SHA-256，不包含 prompt/model version；body 的 hash/userId 一律拒絕。

新增 Supabase table `semantic_entry_requests`，唯一鍵 `(user_id,request_id)`，保存 input_hash、expense_id、原成功 response snapshot、created_at。新增 SQL RPC `create_semantic_expense(p_request_id uuid,p_input_hash text,p_expense jsonb) returns jsonb`。同一 POST RPC transaction 內鎖定／建立 request row、驗證 payload、新增 expense、保存成功 snapshot；任何 exception 全部 rollback。

- 相同 user/request ID、相同 input hash：回傳既有 snapshot，不再新增或覆寫 expense，即使重試的模型輸出不同。
- 相同 ID、不同 input hash：409 conflict；不同使用者同 UUID 不衝突。
- 並行重送：unique constraint + row lock 保證最多一筆；不能先查再分成兩個 API 寫入。
- 原 expense 後來被編輯或刪除：保留 request tombstone，重送不復活資料；回傳原成功 snapshot，前端 refresh 真實清單，不把 snapshot 覆寫新資料。
- 只保留完成的 request rows；RPC 前失敗沒有 expense。結果不明時可 GET /semantic-entry/:requestId 查完成狀態，沒有 row 回 not_found，這不證明沒有其他 instance 正在處理。

此保證是「同一 user/request ID 最多一筆成功 expense」，不是模型 exactly-once，也不保證不同 UUID 的同一句話被語意去重。已成功請求先 replay lookup 可避免通常的重複模型費；並行或 persist 前中斷仍可能再次呼叫模型。request tombstones 不自動過期，以免過期重送再次新增；原始文字不保存。

成功 response `{status:'created',requestId,expense:ExpenseRow,replayed:boolean,metadata}`；422 response `{status:'rejected',requestId,issues}` 沒有可儲存草稿。其他錯誤 400/401/403/409/429/502/504。GET 回 completed snapshot 或 not_found；caller identity 與 RLS 不變。

## 成本與安全限制

候選模型 gpt-5.4-mini、promptVersion=semantic-entry-v1，由後端設定版本。每次 execution 最多一次模型呼叫，max_output_tokens=800、reasoning effort=none、model deadline=15 秒；整個 HTTP deadline=30 秒。沒有自動重試模型或自動改 request ID。

每位使用者每日最多 100 次新解析 attempt，台灣日；新增 operational quota table 與 atomic RPC，模型呼叫前消耗，失敗及並行重新解析也計次，成功 replay lookup 不消耗。額度不是美元硬上限。

OPENAI_API_KEY 由 GCP Secret Manager 提供；public frontend 只新增 PUBLIC_SEMANTIC_ENTRY_URL。後端配置 SEMANTIC_MODEL、SEMANTIC_MEMBER_NAMES、SEMANTIC_OTHER_CATEGORY_ID、SEMANTIC_ALLOWED_ORIGINS 與 Supabase URL/publishable key。CORS 不取代 JWT 驗證。

日誌只保存 requestId、node、model、promptVersion、status/issue codes、elapsedMs、usage、replayed；不保存 token、原文、expense payload、email 或姓名。RPC result snapshot 包含支出資料，只允許 request owner 讀取，與一般 logs 分開。不啟用外部 raw-payload tracing。

## Evidence 與驗收

40 個合成固定案例，每類 5 個：完整輸入、預設值與缺漏、日期邊界、付款人成員、分攤、金額／幣別、不支援多筆、指令注入。預期結果人工定義。相同原始模型輸出分別評分 baseline 與 normalized/validated harness，各案例 3 runs、最多 120 次付費呼叫；語意評估不寫正式資料庫。

記錄欄位正確率、auto-create eligibility precision、合法案例 recall、拒絕判定、無效 payload 攔截率、用量、成本、p50/p95 與 failure denominators。Mock graph tests 證明順序／無人工等待；live eval 證明固定案例語意品質；local Supabase integration 證明 transaction、RLS、quota、重送效果；container tests 證明啟動與 HTTP wiring。它們不是 hosted GCP/production DB 的替代證據。

試用門檻：deterministic 與 40 個案例 validation tests 全通過；E2E 無確認直接完成、拒絕零新增；並行重送／commit 後 response 丟失仍只一筆；同 ID 改文字被拒絕；cross-user access 被拒絕；live eligibility precision >=95%、合法 recall >=90%，揭露小樣本限制。precision 無 eligible samples 時為 N/A。

## 部署與規劃邊界

目前 repo 的 SQL schema/RLS 不在版控；實作前需取得去識別化的實際 schema／policies，先核對 expense insert requirements 再製作可攜 migration 與 disposable fixture。不得用前端 type 或 inherited notes 當已驗證部署 schema。

Cloud Run 費用依 region、共用免費額度與 ancillary services；先前 US$0–5 hosting／1,000 次模型 US$2.10 都是情境估算，不是量測或帳單。此文件不授權 paid eval、正式 migration 或部署。既有計畫檔保留 2026-10-11 名稱作連結穩定性；本次更新日期為 2026-10-12。

## 官方參考

- [Cloud Run containers](https://docs.cloud.google.com/run/docs/deploying)
- [LangGraph orchestration](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Supabase database functions](https://supabase.com/docs/guides/database/functions)
- [PostgREST transactions](https://docs.postgrest.org/en/stable/references/transactions.html)
