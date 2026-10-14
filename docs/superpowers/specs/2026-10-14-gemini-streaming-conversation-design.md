# Gemini 串流分析與規則式記帳設計

日期：2026-10-14。狀態：修訂設計與實作計畫已核准，repository implementation／local verification 完成；hosted acceptance 尚未驗證。結果見 [驗證紀錄](../../evidence/semantic-entry/2026-10-14-streaming-analysis.md)。

## 目標與使用者體驗

Gemini 根據原始輸入、同一筆支出的補充對話，以及後端提供的可信 context，抽取支出資料並產生簡短分析摘要。資訊完整性、補充問題選擇及是否寫入維持由程式依現有欄位與規則判斷。前端先呈現 Gemini 的串流分析說明，再顯示程式選出的固定補充問題或最終結果。沒有欄位草稿、預覽確認或新增核准步驟。

「分析」是模型專門產生給使用者閱讀的摘要，例如「已辨識午餐支出，還需要確認總金額」。採純文字呈現，不呈現 provider 的 thought parts、內部指令、原始 JSON 或任意 HTML。分析在生成期間屬暫時說明，不能宣稱已完成資料庫寫入。

保留最多三輪補充、每輪一次模型呼叫、既有支出範圍及自動寫入行為。寫入後要求 Gemini 更新或刪除資料不在本次範圍。

## 已確認的責任分工

- Gemini 只負責抽取支出欄位與產生分析摘要。摘要是暫時說明，不是完整性、追問或寫入決策。
- LangGraph 編排驗證身分、載入 context、查詢既有結果、額度、模型抽取、程式檢查與持久化等節點。
- Service 使用現有 normalize 判斷欄位完整性、合法性及資料轉換，clarification_result 選擇固定問題。驗證通過即自動進入 persist；不需要模型 ready 決策或使用者批准。輸入格式、授權、金額範圍、既有成員／分類、日期及分攤等規則保留。
- Supabase 仍是持久化來源；身分與資料授權不由模型決定。資料庫確認成功後才產生 created 結果。
- FastAPI／Uvicorn 透過現有 POST SSE 回應向前端傳送事件。`/health` 和 Cloud Run 啟動方式不變。

## 現況與變更

Repository 已有 FastAPI routing，Gemini adapter 使用 HTTPX 的非串流 generateContent。LangGraph 的 extract 節點等待完整 extraction，normalize 判定資料是否有效，clarification.py 依規則選擇固定問題。外層 handler 用 Queue 與 StreamingResponse 傳送 persisting、result、error。

本次只增加 Gemini 分析摘要、上游串流與前端分析事件。normalize 與 clarification_result 的既有責任和行為保留。資訊不足且可補充時仍回傳 needs_input 與固定問題；不支援或補充上限用完時回傳 rejected；通過驗證才寫入。不新增模型選題、決策或隱藏修復呼叫。

## Provider 回應格式

每次模型呼叫產生一個 structured JSON envelope，只包含兩個必填欄位，禁止額外欄位：

| 欄位       | 規則                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| analysis   | 1–200 個 Unicode code points，給使用者的繁體中文分析摘要；prompt 目標 40–80 字     |
| extraction | 完整符合現有 extraction schema 的物件；缺少資料仍依既有 nullable／missing 欄位表示 |

不新增 decision、question 或模型 issues 欄位。Provider 驗證完整 envelope 後，將 extraction 映射回既有回傳值 raw，以維持 normalizer、graph 與 fixture evaluation 的職責。分析只透過 callback 傳遞，不送入驗證函式，不作為 graph 路由或持久化資料。

Gemini 可以在摘要描述已辨識資訊或不確定之處，但 prompt 要求避免對完整性作最終保證、直接要求使用者作答，或宣稱已存檔。模型摘要和程式判斷可能不一致，UI 必須以後續固定問題／最終結果為準。即使摘要寫「金額完整」，amount=null 仍由程式要求補充。

現有 normalize 的產品預設、台灣日期、補充答案優先順序、成員／分類限制、個人／家庭分攤均保持不變。追問最多三輪、固定問題優先順序及終止規則保持不變。Replay 在模型呼叫之前直接回傳，不消耗新額度，也不產生新的分析。

Prompt version 升版；requestId、input hash 演算法、已完成 snapshot 和 status lookup 不變。不改 SQL、quota 或正式資料庫結構。

## Gemini 串流與解析

使用同一個 Gemini REST API 系列的 streamGenerateContent?alt=sse，保留 API key header、現有模型選項、15 秒模型總時限、800 output token cap 與無自動重試策略。這些限制適用整個串流，不因每次收到 chunk 而重設。

HTTPX 使用 streaming response，增量解碼上游 SSE；處理 UTF-8、LF／CRLF、多行 data、任意網路 chunk 邊界及終止事件。上游 SSE frame 及累積文字分別限制 64 KiB；超過限制終止並視為 provider_invalid。只有一個 candidate，忽略 thought parts，不轉送 provider 原始事件。

累積 structured JSON 時，只增量讀取頂層 analysis 字串。解析器需辨識 JSON 結構與 escape，包括跨 chunk 的反斜線、引號、Unicode escape 及 surrogate pair；不以正則截取 JSON，也不替未完成 JSON 補括號後當正式資料解析。重複頂層欄位、非預期結構或無效 escape 不得促成寫入。

Prompt／schema 將 analysis 放前面以利提早顯示，但不把 provider 欄位順序當正確性保證。analysis 晚出現時延後顯示，不能捏造分析文字。完整回應必須通過嚴格 JSON／envelope 驗證、有合法完成原因 STOP，且沒有 refusal／截斷，才能將 extraction 交給現有 normalize。最後累積的分析必須與完整 envelope 一致。

Usage metadata 按 provider 的最終有效資訊計算，不能把累積 token 計數在每個 chunk 重複相加；無法取得時保持 null。任何已顯示分析都不能取代最終結果或寫入確認。

## LangGraph 與事件分工

既有 graph 節點與路由維持：authenticate → load_context → lookup；未完成請求進 quota → extract → validate。validate 依現有 normalizer 判斷；有效才進 persist，無效則依 clarification_result 產生固定問題或拒絕結果。摘要不影響分支。

extract 節點呼叫 provider 時，傳入可選的 on_analysis callback。Provider 接收到已解碼的 analysis 片段時，由 graph 的 callback 接力至 handler Queue。沿用現有 on_persisting 與 ainvoke 執行模式即可；不為增加串流而改寫為 LangGraph astream/custom streaming。這樣保留原本的任務生命週期與決策邏輯，也支援 HTTPX 自訂 provider。

Provider 的非串流呼叫介面仍可用於合成評估；streaming 方法接收相同 text/context 與 on_analysis callback，最後回傳相同 raw/model/token metadata 格式。graph 可選擇有 callback 的串流路徑，或無 callback 的既有相容路徑；兩者採用相同 envelope 與 extraction 驗證。

非串流 POST 與 SSE POST 使用同一套 graph 和驗證規則。Graph 的結果形成唯一的 terminal result。不得把完整 graph state、context、token 或 raw provider payload 直接轉送至瀏覽器。

Handler 保留對操作 task 的強參考及既有寫入不確定性處理。事件 Queue 上限 64；使用 await 產生背壓，不丟棄 persisting／result／error。出錯且 Queue 滿時可以丟棄待送 analysis，以非阻塞方式保留 persisting／terminal error；斷線 cleanup 釋放待送事件，避免保留未開始 RPC 的 task。整體仍受 30 秒服務時限約束。

在 persist 前連線中斷時取消模型／graph 工作並關閉上游 HTTP stream。一旦進入持久化，回應中斷不主動取消已接受的寫入；任務仍受原時限與容器生命週期限制，不能宣稱持久背景執行。恢復方式仍為同 requestId 查詢／重試。

## SSE 合約與相容性

前端透過 `Accept: text/event-stream; semantic-version=2` 選擇新事件。未指定版本的既有客戶端只收到原本的 persisting／result／error；新前端連到舊後端時仍可處理沒有分析事件的舊串流，不等待分析才完成。

新增事件 analysis_delta，payload 僅含 requestId、seq、text。seq 從 0 開始逐次加一，text 為非空已解碼文字，每筆及總累積上限均為 200 Unicode code points。前端檢查相同 requestId、連續 seq、總量及事件次序。分析事件只能出現在 persisting 或 terminal event 之前。

既有 persisting、result、error payload 和非串流 JSON response 不變。終止事件只能有一個；EOF 缺少終止結果、亂序或壞事件不能視為成功。前端仍限制 SSE 總接收量 64 KiB，transport timeout 32 秒。

前後端更新需透過版本協商驗證後端先發／前端先發兩種順序。CORS 保留既有規則，Accept 版本參數不新增自訂 request header。

## 前端行為與生命週期

在文字記帳對話框的既有處理中區域顯示「Gemini 分析中」及累積分析純文字；不新增欄位卡片或批准按鈕。畫面收到 persisting 後保留分析並顯示現有正在記帳訊息。收到 needs_input 時顯示程式選出的固定問題；created 只顯示實際保存結果；rejected／error／uncertain 保留清楚的終態。

分析以短段落顯示，不讓 aria-live 在每一個字更新時反覆朗讀。分析每輪重新開始；對話中只保留原本的 question／answer history。分析不送回模型作為 history，也不寫入 localStorage、IndexedDB、資料庫、日誌或 tracing。

新操作、關閉、帳號變更、頁面卸載及重新查詢結果時清除分析；異步 callback 仍使用既有 accountId／revision 檢查，避免舊請求更新新帳號或新操作。busy 階段鎖定與不確定結果恢復規則保持不變。

## 範圍與檔案責任

- provider.py／prompt.py：Gemini extraction＋analysis envelope、串流呼叫及最終 metadata。
- 新的 provider stream parser 模組：上游 SSE 與 analysis JSON 字串增量解析；不混入資料庫或 UI 責任。
- contracts.py／graph.py：嚴格 envelope 驗證與 on_analysis callback 接力；維持 normalizer、clarification.py 固定問題、graph 分支與追問上限。clarification.py 不需產品行為改動。
- handler.py：版本協商、事件編碼、背壓、取消與不確定性。
- packages/semantic-entry-contract：analysis_delta wire type／validator 與跨語言 parity fixtures。
- semantic-entry.fetcher.ts／SemanticEntryDialog.svelte：事件處理、分析呈現及生命週期清理。
- README、architecture、database、deployment：在實作完成時更新實際行為與驗證限制；歷史 evidence 不改寫成新結果。

本次不做資料庫 migration、寫入後修改、刪除、工具自主呼叫、更多支出類型、持久對話、模型自動重試、部署或付費 live evaluation。

## 成本評估（2026-10-14）

與原架構比較，預期增加的模型費用來自分析指令／envelope schema 及分析摘要，而不是每個 SSE chunk 算一次呼叫。原本每輪已呼叫一次 Gemini；新設計仍是一次，初次加最多三輪補充最多四次，不新增獨立分析、追問或自動修復呼叫。固定問題與追問規則不變，沒有因模型決策新增輪數；但 prompt 改動可能影響 extraction 品質與實際追問輪數，仍需量測。

查閱 [Gemini 官方定價](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite)，gemini-3.5-flash-lite Standard 付費價格為每百萬 input tokens US$0.30、output tokens US$2.50，output 包括 thinking tokens；公開價目未另列 streaming 加價。保留現有 thinking 設定。未確認專案實際 billing tier、免費額度或實際帳單，以下採付費單價、不計 cache／免費額度／稅金的假設估算。

每輪增額公式為 `(新增 input tokens × 0.30 + 新增 output tokens × 2.50) / 1,000,000`。例如假設平均每輪增加 500 input tokens、200 output tokens，每輪增加 US$0.00065；100／1,000／10,000 輪分別增加 US$0.065／0.65／6.50。這是示例，不是測量值，也不能把中文字符數直接當 token 數。

800 output token cap 保持不變只限制單次輸出，不能保證平均費用不增加；原本未用滿上限的輸出現在可能變長。分析以 40–80 字為 prompt 目標、200 字為驗證上限，需以 fixture 驗證結構，再另行授權 live evaluation 檢查分析＋extraction 是否在 800 tokens 內可靠完成。若常截斷，應先縮短摘要／格式；提高 token cap 或 thinking 設定必須重新評估，不能默默變更。

Cloud Run 原本即等待模型回應，新方案延續同一個 HTTP request，不因每個 chunk 增加 request 計數。較長的生成／連線、解碼及較慢客戶端造成的背壓可能增加 billed instance time 與傳輸量，並影響併發容量。並非每筆記帳獨佔 instance，不能直接把每個 request 的時長相加當帳單。維持 min=0、max=2、1 vCPU、512 MiB；沒有新增常駐服務。免費額度及實際區域／帳戶設定需依 [Cloud Run 定價](https://cloud.google.com/run/pricing) 核對，不能保證家庭用量必定免費。

LangGraph 使用本機 library，不新增 LangSmith hosted service、checkpointer、Redis、queue service 或資料庫表。相同成功結果仍只寫一次 expense；分析僅在記憶體，不增加資料庫保存量。額外成本主要是開發維護：上游 SSE／部分 JSON parser、新舊事件版本、斷線及 Unicode 邊界測試，以及摘要與抽取資料一致性的回歸評估。

實作驗收保留不含私密內容的 requestId／promptVersion／model／token counts／elapsedMs；利用授權的合成 live 評估比較新舊成功率、追問輪數、token、首段延遲及總時長，不新增帳單查詢權限或自動付費評估。串流可以縮短第一次可見回應的等待，但不保證模型總時間或帳單降低。

## 驗收與驗證

1. 同一組 extraction 在新舊流程產生相同驗證結果、固定補充問題或寫入資料。資訊不足不得寫入；資料合法即自動寫入一次。
2. 摘要宣稱完整也不能繞過缺少金額／分類／成員／日期等規則。包含 decision／question 等額外 envelope 欄位、超長／空分析、壞結構、截斷或未知 extraction 欄位都不得寫入；仍保留 null／missing 的既有差異。
3. Gemini 模擬串流在最終 envelope 前已可產生分析；以任意 byte 分塊覆蓋繁體中文、emoji、escape、surrogate pair、CRLF、多行 SSE、終止 metadata、拒絕及截斷。
4. 直接在 ASGI／Uvicorn HTTP 傳輸層測試分析先到、結果後到及實際斷線；不能只測 generator。驗證寫入前取消與寫入後結果恢復。
5. 新舊版本協商、一般 JSON POST、GET status、replay、額度及 request/hash parity 都維持正確；完整 graph state 不外洩。
6. Playwright 驗證分析逐段更新、固定問題、補充成功、拒絕、結果待確認、三輪上限、關閉／帳號切換清理及舊請求不覆寫新狀態。確認 root 與 GitHub Pages 子路徑。
7. 執行 repository 規定的 Python pytest、Ruff check／format、mypy、fixture evaluation、Python/browser parity、Docker build／smoke，以及 frontend check／lint／相關 Playwright。既有無關 lint 失敗需照實報告。
8. 不改 SQL，因此不新增資料庫 migration 測試。現有 DB／auth 行為仍需在適當範圍驗證；mock 不代表正式 RLS 或 hosted 成功。

## 證據與後續關卡

Repository-verified：現有非串流 provider、graph／handler、固定追問、前端 SSE validator 與三輪限制已對照原始碼。本文件記錄核准設計；實作與驗證範圍以本次驗證紀錄為準。此版本取代先前 Gemini 決定 ready／needs_input／rejected 與產生問題的提案；不保留兩套決策架構。

Google 文件說明 structured output 可串流。LangGraph 本次保留既有執行方式，分析透過明確 callback 接力；不依賴 LangGraph 自動擷取 HTTPX 模型片段。模型 key／schema 在選定模型上的接受度、成本、首段延遲、Cloud Run 緩衝及中斷行為尚未由 live call 驗證。

- [Gemini structured output streaming](https://ai.google.dev/gemini-api/docs/structured-output#streaming-results)
- [Gemini streaming REST API](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)
- [LangGraph streaming](https://docs.langchain.com/oss/python/langgraph/streaming)

使用者已審閱本修訂設計與實作計畫，選擇本對話逐項執行並完成整體審查。Paid live call、push、merge 與 deploy 仍需要各自已授權的範圍。
