# Gemini 串流對話記帳設計

日期：2026-10-14。狀態：對話方向已確認，等待本文件審閱；尚未實作。

## 目標與使用者體驗

Gemini 根據原始輸入、同一筆支出的補充對話，以及後端提供的可信 context，決定資訊是否完整、是否需要追問，以及是否準備寫入。前端呈現 Gemini 產生的簡短分析說明、補充問題和最終寫入結果。沒有欄位草稿、預覽確認或新增核准步驟。

「分析」是模型專門產生給使用者閱讀的摘要，例如「已辨識午餐支出，還需要確認總金額」。採純文字呈現，不呈現 provider 的 thought parts、內部指令、原始 JSON 或任意 HTML。分析在生成期間屬暫時說明，不能宣稱已完成資料庫寫入。

保留最多三輪補充、每輪一次模型呼叫、既有支出範圍及自動寫入行為。寫入後要求 Gemini 更新或刪除資料不在本次範圍。

## 已確認的責任分工

- Gemini 決定語意資訊是否足夠、產生補充問題及分析摘要，並提出準備寫入的資料。
- LangGraph 編排驗證身分、載入 context、查詢既有結果、額度、模型決策、程式檢查與持久化等節點。
- Service 保留輸入格式、授權、金額範圍、既有成員／分類、日期及分攤等檢查。模型的 ready 決策只有在程式檢查通過後才可進入 persist。
- Supabase 仍是持久化來源；身分與資料授權不由模型決定。資料庫確認成功後才產生 created 結果。
- FastAPI／Uvicorn 透過現有 POST SSE 回應向前端傳送事件。`/health` 和 Cloud Run 啟動方式不變。

## 現況與變更

Repository 已有 FastAPI routing，Gemini adapter 使用 HTTPX 的非串流 generateContent。LangGraph 的 extract 節點等待完整 extraction，normalize 判定資料是否有效，clarification.py 依規則選擇固定問題。外層 handler 用 Queue 與 StreamingResponse 傳送 persisting、result、error。

本次以 Gemini 決策取代規則選題。既有 normalize 保留為獨立的寫入檢查與資料轉換，不再替模型生成追問。Gemini 判斷 ready 但程式檢查未通過時不寫入，回傳既有 rejected／issues 格式；不追加隱藏的模型修復呼叫。

## Provider 決策格式

每次模型呼叫產生一個 structured JSON envelope，所有欄位必須存在，禁止額外欄位：

| 欄位       | 規則                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| analysis   | 1–200 個 Unicode code points，給使用者的繁體中文分析摘要                          |
| decision   | needs_input、ready、rejected 之一                                                 |
| question   | needs_input 時為 1–300 字的單一聚焦問題，其他決策為 null                          |
| issues     | needs_input／rejected 時為非空問題清單，ready 時為空；限制在已知 field／code 集合 |
| extraction | ready 時符合現有 extraction schema；其他決策為 null                               |

ready 只在既有產品預設與可信 context 下足以建立一筆合法支出時使用。模型不能新增分類／成員、猜測金額或將對話內容當作授權。現有補充答案優先順序、台灣日期、個人／家庭分攤規則保留。

needs_input 在三輪補充尚未用完時原樣採用模型問題；已達三輪則轉為 rejected，不再要求第四輪。模型拒絕、錯誤結構或輸出截斷都不寫入。Replay 在模型呼叫之前直接回傳，不消耗新額度，也不產生新的分析。

Prompt version 升版；requestId、input hash 演算法、已完成 snapshot 和 status lookup 不變。不改 SQL、quota 或正式資料庫結構。

## Gemini 串流與解析

使用同一個 Gemini REST API 系列的 streamGenerateContent?alt=sse，保留 API key header、現有模型選項、15 秒模型總時限、800 output token cap 與無自動重試策略。這些限制適用整個串流，不因每次收到 chunk 而重設。

HTTPX 使用 streaming response，增量解碼上游 SSE；處理 UTF-8、LF／CRLF、多行 data、任意網路 chunk 邊界及終止事件。上游 SSE frame 及累積文字分別限制 64 KiB；超過限制終止並視為 provider_invalid。只有一個 candidate，忽略 thought parts，不轉送 provider 原始事件。

累積 structured JSON 時，只增量讀取頂層 analysis 字串。解析器需辨識 JSON 結構與 escape，包括跨 chunk 的反斜線、引號、Unicode escape 及 surrogate pair；不以正則截取 JSON，也不替未完成 JSON 補括號後當正式資料解析。重複頂層欄位、非預期結構或無效 escape 不得促成寫入。

Prompt／schema 將 analysis 放前面以利提早顯示，但不把 provider 欄位順序當正確性保證。analysis 晚出現時延後顯示，不能捏造分析文字。完整回應必須通過嚴格 JSON／envelope 驗證、有合法完成原因 STOP，且沒有 refusal／截斷，才能採用 decision。最後累積的分析必須與完整 envelope 一致。

Usage metadata 按 provider 的最終有效資訊計算，不能把累積 token 計數在每個 chunk 重複相加；無法取得時保持 null。任何已顯示分析都不能取代最終結果或寫入確認。

## LangGraph 與事件分工

保留 authenticate → load_context → lookup；未完成請求再進 quota → decide。decide 節點內呼叫 provider，透過 LangGraph custom streaming 發出經篩選的 analysis delta。Gemini ready 進入 validate；通過才進 persist，否則終止。needs_input／rejected 直接形成結果。

使用 LangGraph 的 custom stream writer 將分析與 persisting 事件傳向 transport；graph 執行結果形成唯一的 terminal result。非串流 invoke 與串流 runner 使用同一套 graph 和決策驗證邏輯。不得把完整 graph state、context、token 或 raw provider payload 直接轉送至瀏覽器。

Handler 保留對操作 task 的強參考及既有寫入不確定性處理。事件 Queue 上限 64；使用 await 產生背壓，不丟棄 persisting／result／error。整體仍受 30 秒服務時限約束。

在 persist 前連線中斷時取消模型／graph 工作並關閉上游 HTTP stream。一旦進入持久化，回應中斷不主動取消已接受的寫入；任務仍受原時限與容器生命週期限制，不能宣稱持久背景執行。恢復方式仍為同 requestId 查詢／重試。

## SSE 合約與相容性

前端透過 `Accept: text/event-stream; semantic-version=2` 選擇新事件。未指定版本的既有客戶端只收到原本的 persisting／result／error；新前端連到舊後端時仍可處理沒有分析事件的舊串流，不等待分析才完成。

新增事件 analysis_delta，payload 僅含 requestId、seq、text。seq 從 0 開始逐次加一，text 為非空已解碼文字，每筆及總累積上限均為 200 Unicode code points。前端檢查相同 requestId、連續 seq、總量及事件次序。分析事件只能出現在 persisting 或 terminal event 之前。

既有 persisting、result、error payload 和非串流 JSON response 不變。終止事件只能有一個；EOF 缺少終止結果、亂序或壞事件不能視為成功。前端仍限制 SSE 總接收量 64 KiB，transport timeout 32 秒。

前後端更新需透過版本協商驗證後端先發／前端先發兩種順序。CORS 保留既有規則，Accept 版本參數不新增自訂 request header。

## 前端行為與生命週期

在文字記帳對話框的既有處理中區域顯示「Gemini 分析中」及累積分析純文字；不新增欄位卡片或批准按鈕。畫面收到 persisting 後保留分析並顯示現有正在記帳訊息。收到 needs_input 時顯示模型問題；created 只顯示實際保存結果；rejected／error／uncertain 保留清楚的終態。

分析以短段落顯示，不讓 aria-live 在每一個字更新時反覆朗讀。分析每輪重新開始；對話中只保留原本的 question／answer history。分析不送回模型作為 history，也不寫入 localStorage、IndexedDB、資料庫、日誌或 tracing。

新操作、關閉、帳號變更、頁面卸載及重新查詢結果時清除分析；異步 callback 仍使用既有 accountId／revision 檢查，避免舊請求更新新帳號或新操作。busy 階段鎖定與不確定結果恢復規則保持不變。

## 範圍與檔案責任

- provider.py／prompt.py：Gemini structured 決策、串流呼叫及最終 metadata。
- 新的 provider stream parser 模組：上游 SSE 與 analysis JSON 字串增量解析；不混入資料庫或 UI 責任。
- contracts.py／graph.py／clarification.py：嚴格 envelope 驗證、Gemini 決策分支及追問上限；移除執行流程中的固定問題選擇。
- handler.py：版本協商、事件編碼、背壓、取消與不確定性。
- packages/semantic-entry-contract：analysis_delta wire type／validator 與跨語言 parity fixtures。
- semantic-entry.fetcher.ts／SemanticEntryDialog.svelte：事件處理、分析呈現及生命週期清理。
- README、architecture、database、deployment：在實作完成時更新實際行為與驗證限制；歷史 evidence 不改寫成新結果。

本次不做資料庫 migration、寫入後修改、刪除、工具自主呼叫、更多支出類型、持久對話、模型自動重試、部署或付費 live evaluation。

## 驗收與驗證

1. 模型需要補充時問題由模型輸出，問題不必符合舊固定字串；不得寫入。完整資料加合法 ready 才寫入一次。
2. 模型 ready 但金額／分類／成員／日期不合法時不得寫入；ready 缺欄位、超長分析／問題、空 issues、未知 decision 與惡意額外欄位都被拒絕。
3. Gemini 模擬串流在最終 envelope 前已可產生分析；以任意 byte 分塊覆蓋繁體中文、emoji、escape、surrogate pair、CRLF、多行 SSE、終止 metadata、拒絕及截斷。
4. 直接在 ASGI／Uvicorn HTTP 傳輸層測試分析先到、結果後到及實際斷線；不能只測 generator。驗證寫入前取消與寫入後結果恢復。
5. 新舊版本協商、一般 JSON POST、GET status、replay、額度及 request/hash parity 都維持正確；完整 graph state 不外洩。
6. Playwright 驗證分析逐段更新、模型問題、補充成功、拒絕、結果待確認、三輪上限、關閉／帳號切換清理及舊請求不覆寫新狀態。確認 root 與 GitHub Pages 子路徑。
7. 執行 repository 規定的 Python pytest、Ruff check／format、mypy、fixture evaluation、Python/browser parity、Docker build／smoke，以及 frontend check／lint／相關 Playwright。既有無關 lint 失敗需照實報告。
8. 不改 SQL，因此不新增資料庫 migration 測試。現有 DB／auth 行為仍需在適當範圍驗證；mock 不代表正式 RLS 或 hosted 成功。

## 證據與後續關卡

Repository-verified：現有非串流 provider、graph／handler、固定追問、前端 SSE validator 與三輪限制已對照原始碼。本文件是待實作設計，不代表功能已完成。

Google 文件說明 structured output 可串流，LangGraph 文件說明 custom streaming 可整合自訂 LLM client。模型 key／schema 在選定模型上的接受度、成本、首段延遲、Cloud Run 緩衝及中斷行為尚未由 live call 驗證。

- [Gemini structured output streaming](https://ai.google.dev/gemini-api/docs/structured-output#streaming-results)
- [Gemini streaming REST API](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)
- [LangGraph streaming](https://docs.langchain.com/oss/python/langgraph/streaming)

本文件審閱通過後才撰寫實作計畫，再由使用者審閱計畫及選擇執行方式。Paid live call、push、merge 與 deploy 需要各自已授權的範圍。
