# Gemini Streaming Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在保留程式驗證、固定追問和自動寫入的前提下，逐段顯示 Gemini 的簡短分析摘要。

**Architecture:** Provider 回應改為 analysis＋extraction envelope，HTTPX 增量接收 Gemini SSE。LangGraph 保留既有節點、分支及 ainvoke，以 optional callback 接力分析至 handler。前端選擇新版 SSE，只將分析當暫時純文字呈現。

**Tech Stack:** Python 3.12、uv 0.12.7、FastAPI／Uvicorn、HTTPX、LangGraph；Svelte 5／TypeScript、Node 22.12+、Playwright。

**Spec:** [Gemini 串流分析與規則式記帳設計](../specs/2026-10-14-gemini-streaming-conversation-design.md)。本計畫只實作此修訂版本，不實作先前的模型決策／模型選題提案。

## Global Constraints

- Gemini 只產生 analysis 和 extraction；完整性、固定問題、寫入條件使用既有 normalize／clarification_result。
- 摘要 prompt 目標 40–80 字、嚴格上限 200 Unicode code points；空摘要無效；不呈現 thought parts 或 raw JSON。
- 每輪一次 provider call；最多三輪補充；15 秒模型總時限、30 秒 service deadline、32 秒前端 transport timeout、800 output tokens；不新增 retry、工具或模型呼叫。
- 上游 SSE frame 與累積模型文字各限 64 KiB；handler Queue 上限 64；前端 SSE 總量限 64 KiB。
- 維持 Taiwan 日期、現有金額／分類／成員／分攤規則、requestId／hash、replay、quota 和不確定結果恢復。
- `Accept: text/event-stream; semantic-version=2` 協商 analysis_delta；舊版保留既有事件，非串流 JSON payload 不變。
- 分析不進 localStorage、IndexedDB、DB、history、logs 或 tracing；callback 維持帳號／revision 隔離。
- 不做 SQL、正式資料變更、付費 live call、push、merge、deploy 或寫入後編輯。

## Review Focus

1. 部分 JSON 中的 escaped quotation、Unicode surrogate、nested analysis key 不能造成錯誤文字或提前採用 extraction：Task 2。
2. 摘要已出現但後續拒絕、截斷、重複 key 或欄位不完整時不得寫入：Tasks 1–3。
3. 慢客戶端／斷線與事件 Queue 背壓不得卡死或取消已接受的 RPC：Task 3。
4. 舊前端連新後端、新前端連舊後端均能完成且不用等摘要：Tasks 3–4。
5. 新一輪／帳號切換／卸載後舊 callback 不能污染新畫面或洩漏分析：Task 4。

## Setup

- [x] 確認已核准 spec 和 execution method；讀 repository instructions、README 驗證命令及相關 source。檢查 git status，避免覆寫他人變更。
- [x] 建立並 checkout `feat/semantic-entry-streaming-analysis`，基於包含 FastAPI migration 的當前 revision；依 using-git-worktrees 檢查既有隔離，沒有使用者要求時不另建 worktree。
- [x] `uv sync --project services/semantic-entry --locked`；記錄 backend pytest、frontend check／lint 的新 baseline，既有失敗照實報告。確認 frontend synthetic config，不讀取或輸出 private receipts／tokens。

### Task 1: Envelope 與非串流相容路徑

**Files:** Modify `services/semantic-entry/semantic_entry/{prompt,contracts,provider}.py`、`services/semantic-entry/tests/test_provider_supabase.py`; create `services/semantic-entry/tests/test_provider_envelope.py`。

**Interfaces:**

- `load_provider_json(text: str) -> JSON`：拒絕重複 JSON key、非 JSON numbers 及非 object 根節點。
- `parse_provider_envelope(raw: object) -> JSON`：exact keys analysis／extraction，analysis 1–200 Unicode code points；extraction 經既有 parse_extraction，不改 null／missing 規則。
- `Provider.__call__(text: str, context: JSON) -> JSON` signature 不變，仍回傳 raw／model／inputTokens／outputTokens；raw 來自 envelope.extraction，不增加公開 result 欄位。
- `EXTRACTION_SCHEMA` 保留；新增 `PROVIDER_SCHEMA` 包裝兩欄，prompt version 改為 `semantic-entry-v4-streaming-analysis`。

- [x] **Write tests:** `test_envelope_preserves_nullable_extraction` 驗證 RAW 與 amount=null 均保持原值；`test_envelope_rejects_invalid_analysis` 覆蓋空值、非字串、201 字、emoji 計數；`test_envelope_rejects_extra_decision_and_duplicate_keys` 驗證額外 decision／question／巢狀重複 key 拒絕。更新 COMPLETED provider fixture 為兩欄 envelope，保留一次呼叫、token cap、無 tools／retry 的 assertions。
- [x] **Run red:** `uv run --directory services/semantic-entry --locked pytest tests/test_provider_envelope.py tests/test_provider_supabase.py`；確認預期 missing envelope implementation 失敗。
- [x] **Implement:** 加入 schema／嚴格 decoder，修改 prompt 為專供使用者閱讀的短摘要加原有 extraction 規則，非串流結果依新 envelope 驗證；現有 finishReason／refusal／usage 邏輯保留。
- [x] **Run green:** 同上，再執行完整 backend pytest；fixture evaluation 使用 authored raw outputs，不替它新增付費模型呼叫。
- [x] **Review and commit:** `feat: add bounded analysis to provider response`；只提交本 task source／tests。

### Task 2: Gemini SSE 與 analysis 字串增量解析

**Files:** Create `services/semantic-entry/semantic_entry/provider_stream.py`、`services/semantic-entry/tests/test_provider_stream.py`; modify `provider.py`。

**Interfaces:**

- `AnalysisCallback = Callable[[str], Awaitable[None]]` 在 provider_stream.py 宣告，後續 graph 匯入。
- `iter_sse_data(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]`：輸出每個完整 SSE data payload；增量 UTF-8，LF／CRLF／multiline data／comments，64 KiB frame cap。
- `AnalysisDecoder.feed(fragment: str) -> str`：回傳新完成的頂層 analysis 字元；不回傳 incomplete escape／半個 surrogate，不讀 nested analysis；解析狀態總文字限 64 KiB。
- `AnalysisDecoder.finish(analysis: str) -> None`：確認已發出的摘要與完整 envelope 一致、無未完成 escape；差異拋 ValueError。
- `Provider.stream(text: str, context: JSON, on_analysis: AnalysisCallback) -> JSON`：消費上游串流後回傳 Task 1 相同 provider 結果格式。

- [x] **Write tests:** 用 HTTPX AsyncByteStream synthetic fixtures 測試每個 byte 切分下輸出均等於 `午餐「麵」🍜`；包含 escaped quote、backslash、Unicode escape／surrogate、nested key／analysis 後置、多行 SSE。用 asyncio.Event 控制 final envelope 發送，證明 final 前 callback 已收到摘要；HTTP request URL 為 streamGenerateContent、alt=sse、key 只在 header。
- [x] **Write failure tests:** absence STOP、MAX_TOKENS、SAFETY、invalid UTF-8、壞 escape、重複 key、超過 64 KiB、超過 200 字及部分文字後 EOF 均不返回有效 raw；非串流與串流 usage 相同，累積 usage 不重複相加。`test_stream_deadline_is_total` 證明連續 chunk 不重設 15 秒 deadline；`test_cancel_closes_upstream` 確認 transport.aclose 發生，均只有一次 provider request。
- [x] **Run red:** `uv run --directory services/semantic-entry --locked pytest tests/test_provider_stream.py`；確認新 parser／stream method 不存在或行為缺失。
- [x] **Implement:** 狀態式 SSE／JSON string parser；共用 Task 1 envelope decoder、request config、final result／usage helpers。HTTPX async stream 使用整體 timeout，thought parts 不輸出。等待完整 STOP／schema 檢查才返回 extraction。
- [x] **Run green:** targeted tests 加完整 pytest、Ruff、mypy。沒有真實 Gemini calls；模型相容性另列 hosted gap。
- [x] **Review and commit:** `feat: stream bounded Gemini analysis`。

### Task 3: Graph callback、SSE 版本與真實 HTTP 邊界

**Files:** Modify `services/semantic-entry/semantic_entry/{graph,handler,server}.py`、`tests/{test_clarification,export_contract}.py`、`packages/semantic-entry-contract/{src/index.ts,tests/python-parity.mjs}`、`services/semantic-entry/scripts/{smoke-server,smoke-client}.py`; create `services/semantic-entry/tests/test_stream_transport.py`。

**Interfaces:**

- 在 Dependencies 最後新增 `stream_entry: Callable[[str, JSON, AnalysisCallback], Awaitable[JSON]] | None = None`，保留既有 positional 欄位順序與 extract_entry。
- `invoke(request, token, deps, on_persisting=None, on_analysis: AnalysisCallback | None = None) -> JSON`：只有 on_analysis 且 stream_entry 存在時 extract 使用 stream_entry；其他路徑使用 extract_entry。normalize／clarification／hash 分支不變。
- `stream_operation(parsed, token, deps, deadline, include_analysis: bool = False) -> AsyncIterator[bytes]`：新版本啟用 callback；analysis_delta payload 為 `{requestId,seq,text}`，seq 從 0 連續增加，總量 200。舊版只輸出原事件；Queue(maxsize=64)，await put 產生背壓。
- `environment_dependencies` 使用同一 Provider 的 **call** 與 stream 方法；不增加 HTTPX client／模型呼叫。
- SemanticStreamEvent 新增 `{type:'analysis_delta'; requestId:string; seq:number; text:string}`；parseStreamEvent 驗證 exact keys、UUID、非負 safe integer、非空不超過 200 code points。
- Handler 用 media type／parameters 解析 Accept；只對 semantic-version=2 發分析，保留原非串流 JSON 與 deadline。

- [x] **Write tests:** callback 先於 persisting／result；`test_analysis_cannot_override_missing_amount` 回傳摘要「資訊完整」和 amount=null，最終仍為現有固定金額問題、零寫入；正常 RAW 產生相同 expense。Replay 不呼叫 stream_entry；normalizer／追問三輪／quota／hash tests 保持。
- [x] **Write compatibility tests:** v1 無 analysis_delta，v2 有，普通 JSON POST／GET status 不變；Accept quoted parameter、額外 media types 及不支援版本不誤啟用 v2。Export real Python v2 frame 與 malformed seq／UUID／超長文字 cases，Node parity 驗證接受與拒絕。
- [x] **Write transport tests:** Test helper 在 localhost ephemeral port 啟動 real Uvicorn＋synthetic deps，HTTPX stream 未等待終態即可取得第一段；受控停止／finally 清理。close HTTP socket before persistence cancels upstream；after persisting lets accepted synthetic write finish，status 可恢復。blocked reader／64 queue 限制不造成無限等待，保持 deadline，terminal event 不被丟棄；錯誤／拒絕後零寫入。
- [x] **Run red:** `uv run --directory services/semantic-entry --locked pytest tests/test_clarification.py tests/test_stream_transport.py`，以及 `node --experimental-strip-types packages/semantic-entry-contract/tests/python-parity.mjs`。
- [x] **Implement:** callback 接力與版本分支；保持 task 強參考和取消時點，不把 summary 設為 graph state。新增 handler 的分析事件編码與序列／總量限制；Task 2 provider 例外終止為 error。更新 synthetic container smoke 驗證 v2 分析先於 result，並保留 v1 checks。
- [x] **Run green:** targeted／全 backend suite、Python/browser parity、Docker build＋container-smoke；更新 docs/database.md 的 SSE 合約、docs/architecture.md callback 責任、deployment.md 的版本相容說明，明確當前前端仍可使用 v1。
- [x] **Review and commit:** `feat: expose versioned analysis events without changing decisions`。

### Task 4: Fetcher 與文字記帳對話框

**Files:** Modify `src/lib/data/semantic-entry.fetcher.ts`、`src/lib/components/semantic-entry/SemanticEntryDialog.svelte`、`e2e/semantic-entry.test.ts`、`README.md`、`docs/architecture.md`。

**Interfaces:**

- 新增 exported `SemanticAnalysisDelta = {requestId:string; seq:number; text:string}`。
- `submitSemanticEntry(request, signal?, onPersisting?, onAnalysis?: (delta: SemanticAnalysisDelta) => void): Promise<SemanticResponse>`，保留原三個 argument 的相容性。
- 前端 POST Accept 改 v2；fetcher 每輪維護 nextSeq／analysisCodePoints，先驗證 requestId、seq、200 字、尚未 persisting／terminal，再呼叫 callback。舊後端沒有分析仍正常完成。
- Dialog 新增 in-memory analysis 字串；processing 區域顯示「Gemini 分析中」，文字普通 interpolation。analysis container 不使用逐字 aria-live；existing status aria-live 保留。callback 僅 stillCurrent(version, owner) 時更新。

- [x] **Write E2E tests:** localhost controlled chunk server 在 result 前發送兩段中文摘要，第二段前畫面已顯示第一段；fixed needs_input question 隨後出現；相同 RAW 寫入結果不變。重用既有 live SSE 測試 server，不以一次 route.fulfill 模擬逐段到達。
- [x] **Write regression tests:** 額外摘要為 HTML 樣式文字僅顯示字串、不生成元素；seq gap／重複／錯 UUID／201 字／persisting 後摘要為 invalid_response，保留 uncertain recovery；沒有摘要的 legacy stream 正常完成。新操作／每輪補充／帳號切換／query status 清除分析，舊 callback 不覆寫新狀態；storage 只含 UUID，history 仍只含 question／answer。
- [x] **Run red:** `npm run test:e2e -- e2e/semantic-entry.test.ts`，使用 README synthetic configuration，BASE_PATH 為空；新 assertions 因無 UI／callback 失敗。
- [x] **Implement:** fetcher event 分支和第四個 callback；Dialog 累積分析與清理，busy／saved result／固定問題／retry payload 不變。更新既有測試的 Accept assertion；README 描述規則式決策與串流摘要。
- [x] **Run green:** `npm run check`、`npm run lint`、root semantic Playwright；再 `BASE_PATH=/expense-app E2E_BASE_PATH=/expense-app npm run test:e2e -- e2e/semantic-entry.test.ts`。Whole-repo lint 若因既有無關檔失敗，列出檔案與原因，另外 changed-file checks 不得冒稱全 repo 通過。
- [x] **Review and commit:** `feat: show streaming analysis in semantic expense entry`。

### Task 5: 整合驗證與交接

**Files:** Modify spec／plan checkbox 狀態及 `docs/semantic-entry-deployment.md` 的本次驗證限制；僅在真正需要時建立 dated evidence artifact，不覆寫歷史 log。

- [x] 確認 Tasks 1–4 綠燈，完整 branch diff 符合 spec；無模型 decision／question 遷移、SQL、分析持久化或新增付費服務。對所有新增 imports／Markdown links 檢查 source 路徑。
- [x] 執行 `uv run --directory services/semantic-entry --locked pytest`、`ruff check .`、`ruff format --check .`、`mypy`（後三者同樣使用 uv run --directory services/semantic-entry --locked）；fixture evaluation：`uv run --directory services/semantic-entry --locked python -m semantic_entry.evaluation --mode fixture --out /tmp/jopie-streaming-fixture-eval`。
- [x] 執行 `node --experimental-strip-types packages/semantic-entry-contract/tests/python-parity.mjs`、`docker build -f services/semantic-entry/Dockerfile -t jopie-semantic-entry .`、`services/semantic-entry/scripts/container-smoke.sh`，確認真實 socket 分段與取消 tests 通過。
- [x] 前端完成 Task 4 check／lint／root＋subpath semantic E2E；沒有新增變更或未解風險時不重複相同檢查。carousel／SQL 未變更，不新增其測試範圍。
- [x] 對 changed Markdown／TS／Svelte 執行 Prettier／適用 ESLint 與 `git diff --check`；請 independent reviewer review whole branch，修復 blocking issues 後只重跑受影響 checks。
- [x] 交接分別列 repository-verified、operator-reported、unverified；標註 hosted Gemini schema／800 tokens／延遲／成本／Cloud Run buffering 仍待授權 live validation。保持 localhost-only fixtures、無 paid call／production DB／push／merge／deploy。
- [x] 提交剩餘文件與驗證結果：`docs: document streaming analysis verification`；請使用者決定後续整合，不自行發布。

## Plan Self-Review

- Spec 的 envelope、stream parsing、fixed decisions、versioned events、UI lifecycle、cost limits 與驗收皆有對應 task。
- 每個新介面已命名；callback argument ordering 保留 existing callers；Dependencies 新欄位加在末尾。
- 五個 Review Focus 各有具體 test；不使用 source-text assertion 代替 transport／parser 行為驗證。
- 現有 fixture mode 不測實際模型品質；本計畫不自動執行 live 評估。成功率／成本數值不能由 mock 推論。
- 本計畫已依核准的 native execution 完成；執行方法以每項紅綠測試＋最後整體獨立審查取代每項 reviewer。Whole-repo lint 仍有既有失敗；詳見 [驗證紀錄](../../evidence/semantic-entry/2026-10-14-streaming-analysis.md)。
