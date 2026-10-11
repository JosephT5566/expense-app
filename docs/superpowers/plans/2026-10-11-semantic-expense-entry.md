# Semantic Expense Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 送出一句文字後自動新增一筆支出，透過 Supabase RPC 保證同一請求不重複寫入，並建立 product harness evidence。

**Architecture:** Node.js 22 HTTP service 與 LangGraph library 包裝為 Cloud Run serverless container。後端驗證 Supabase JWT、解析／驗證，再透過 HTTPS RPC 在單一 transaction 新增 expense 並保存 request 結果。前端只送出與顯示結果；沒有確認草稿或直接 expense write。

**Tech Stack:** 現有 Svelte 5、SvelteKit、TypeScript、Supabase JS、Playwright；新增 Node.js 22 service、@langchain/langgraph/@langchain/core、Vitest、tsx、Docker、Supabase CLI local stack。Backend 使用獨立 package.json/package-lock.json；套件版本在實作時核對 Node 22 相容性並鎖定。沒有 Deno runtime、Supabase Edge Function、Cloud SQL、Redis 或付費 LangSmith 部署。

**Spec:** [更新設計](../specs/2026-10-11-semantic-expense-entry-design.md)，更新於 2026-10-12。架構方向已同意，執行方式尚未選定；只更新文件，不代表實作／部署完成。

## Global Constraints

- 第一版只支援單筆、正整數 TWD 支出。
- 無法可靠判定時結束並顯示原因，不新增、不猜金額。
- 個人付款人必須為登入者，shares_json 為其全額；家庭分攤總和必須等於 amount。
- 個人 is_settled=true，家庭=false。
- 每次 execution 最多一次模型呼叫，max_output_tokens=800、reasoning effort=none、model deadline=15 秒；整個 HTTP deadline=30 秒。
- 每位使用者每日最多 100 次新解析 attempt，台灣日。
- GCP 不需要 PostgreSQL password、直接資料庫連線或 connection pool。
- 此文件不授權 paid eval、正式 migration 或部署。

## Review Focus

1. 台灣午夜與跨月日期：today/yesterday 不受裝置時區影響，invalid/future 日期拒絕（Task 1）。
2. 預設值與明示歧義：缺少付款人可預設，未知付款人不能預設；fallback category 缺失停止（Tasks 1/3）。
3. 同 UUID 並行、同 UUID 不同文字與跨帳號重送：單筆／409／隔離（Task 2）。
4. DB commit 後 response 遺失、後續編輯／刪除與重送：不重建，不覆寫（Tasks 2/4）。
5. 關閉頁面／切換帳號／遲到 response：隔離 UI 結果，不能把 abort 當取消已接受的 write（Task 4）。

---

## File Structure

以下 Create paths 均為 planned；現有 expense row types、stores/cache、home page 與 Playwright fixture 已核對。既有手動記帳編輯器不改為自動提交。

| Files                                                                                                                                         | Responsibility                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Create `packages/semantic-entry-contract/{package.json,src/index.ts}`                                                                         | Browser/server 共用 DTO 與 runtime response validation；無 Node/Svelte dependency |
| Create `services/semantic-entry/{package.json,package-lock.json,tsconfig.json,Dockerfile,.dockerignore}`                                      | Node 22 service 與 container                                                      |
| Create `services/semantic-entry/src/{normalize,prompt,provider,supabase,graph,handler,server}.ts`                                             | 純規則、模型、caller-scoped RPC adapter、graph、HTTP wiring                       |
| Create `services/semantic-entry/tests/{normalize,provider,graph,handler,db.integration}.test.ts`                                              | Unit/mock 與 disposable DB tests                                                  |
| Create `supabase/{config.toml,fixtures/semantic-entry-test-schema.sql}`                                                                       | Disposable stack 與明確標示範圍的 test schema                                     |
| Create `supabase/migrations/202610120001_semantic_entry.sql`                                                                                  | quota、request ledger、RLS、transactional RPC                                     |
| Create `src/lib/data/semantic-entry.fetcher.ts`, `src/lib/components/semantic-entry/SemanticEntryDialog.svelte`                               | 提交／查結果／顯示成功拒絕與 uncertain state                                      |
| Modify `src/routes/+page.svelte`                                                                                                              | 新入口與成功後 refresh/store integration                                          |
| Create `e2e/semantic-entry.test.ts`                                                                                                           | 零人工確認 UI、mock backend／auth                                                 |
| Create `services/semantic-entry/evals/{cases.json,run.ts,score.ts,score.test.ts}`                                                             | 40 fixtures、fixture/live runner 與評分                                           |
| Create `docs/evidence/semantic-entry/README.md`, `docs/semantic-entry-deployment.md`                                                          | Evidence index 與 Cloud Run deployment instructions                               |
| Modify root `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `.gitignore`, CI, README, architecture/database, AGENTS | Contract dependency、scope checks、setup 與新 boundary                            |

## Task 1: Shared contract and automatic-entry rules

**Interfaces:** `SemanticRequest={requestId:string,text:string}`。`SemanticContext={today:string,currentUserEmail:string,members:{id:string,email:string,name:string}[],categories:{id:string,name:string}[],otherCategoryId:string}`。`ModelExtraction={note:string|null,amount:number|null,currency:string|null,date:{kind:'today'|'yesterday'|'day_before_yesterday'|'absolute'|'missing',value:string|null},payerId:string|null,scope:'personal'|'household'|null,hasSharedIntent:boolean,splitMemberIds:string[]|null,categoryId:string|null,unsupportedReason:string|null}`。`normalizeExtraction(raw:unknown,ctx:SemanticContext):ValidationResult` 為 `{status:'valid',expense:ValidatedExpense}` 或 `{status:'rejected',issues:Issue[]}`；ValidatedExpense fields 為 note/amount/currency:'TWD'/ts/payer_email/scope/shares_json/category_id/is_settled。共用 DTO 定義 `Issue={field:string,code:string}`、`Metadata={model:string,promptVersion:string,inputTokens:number|null,outputTokens:number|null,elapsedMs:number}`、`CompletedResult={expense:ExpenseRow,replayed:boolean}`；SemanticResponse 為 created（expense/replayed/metadata）或 rejected（issues）；`parseRequest`／`parseResponse` 驗證 unknown。成功 response 使用現有 ExpenseRow contract，不複製另套不一致欄位。

- [ ] **Step 1: Write failing tests** normalize.test.ts：today 缺省、台灣跨月 yesterday、851 均分 426/425、personal 全額且 settled、unknown payer 拒絕、missing amount 拒絕、fallback category 存在／不存在、future/2月30日、USD/退款/多筆拒絕、Unicode 500/501、extra keys 與 invalid UUID。代表 assertions：

```ts
expect(normalizeExtraction(raw851, context)).toMatchObject({
	status: 'valid',
	expense: { shares_json: { 'a@example.test': 426, 'b@example.test': 425 } }
});
expect(normalizeExtraction({ ...raw851, amount: null }, context).status).toBe('rejected');
expect(() => parseRequest({ requestId: 'bad', text: '午餐100' })).toThrow();
```

- [ ] **Step 2: Run** `npm --prefix services/semantic-entry test -- tests/normalize.test.ts`；測試 scaffolding 隨本任務建立，預期 FAIL（missing implementation）。backend test script=`vitest run`，check=`tsc --noEmit`；前後端 contract 透過 local file dependency 接線並 commit lockfiles。
- [ ] **Step 3: Implement interfaces**，amount <=Number.MAX_SAFE_INTEGER；date 轉台灣午夜 ISO，均分按 email 字典序。missing scope 且無 shared intent 預設 personal；明示 household 需確定成員。note/category/member IDs 驗證後才產生 ValidatedExpense；issue codes 固定 missing/invalid/unknown_member/ambiguous_member/unsupported/configuration。
- [ ] **Step 4: Run** normalize tests 與 backend check，預期 PASS。共用 package 僅 portable TypeScript，root/frontend check 仍覆蓋它；service 使用獨立 tsconfig，不把 backend errors 全域忽略。
- [ ] **Step 5: Commit** message `feat: define automatic semantic expense contracts`。

## Task 2: Supabase transactional idempotency and quota

**Prerequisite:** 已部署 expense SQL/RLS 不在 repo。先取得 schema/policies 並核對必要欄位／權限；不能用 inherited notes 當已驗證來源。若仍缺資料，只能驗證明確標記的 disposable frontend-contract fixture，正式相容性記 unverified；實際 migration 定稿前必須取得 schema。

**Interfaces:** `create_semantic_expense(p_request_id uuid,p_input_hash text,p_expense jsonb) returns jsonb` 回 `{expense:ExpenseRow,replayed:boolean}`；`consume_semantic_entry_quota() returns boolean`；request table unique(user_id,request_id)，quota table primary key(user_id,day)。request user_id 一律 auth.uid()。runtime caller 用 user JWT，HTTPS RPC，無 direct DB connection。

- [ ] **Step 1: Write failing db.integration tests.** two synthetic users：parallel 20 同 UUID/hash，assert expense count=1／20 responses 同 expense ID；同 UUID 改 hash→409 domain conflict；two users 同 UUID各一筆；insert validation failure→expense/request rows皆零；commit 後丟棄 response 再呼叫→同 ID；expense edit/delete 後 replay→不覆寫／不復活；cross-user ledger read 拒絕；direct ledger/quota mutation 拒絕。quota parallel101→100 true/1 false；anonymous RPC 拒絕。
- [ ] **Step 2: Run** `supabase start` 後 `npm --prefix services/semantic-entry run test:integration`；script=`vitest run tests/db.integration.test.ts`，僅 localhost test URL，拒絕 remote host。未建 RPC 時預期 FAIL；沒有 Docker/CLI 或 schema 時精確報告驗證範圍。
- [ ] **Step 3: Implement migration**，RPC 使用 restricted security definer、fixed search_path、驗證 auth.uid()/allowlist、檢查金額/scope/payer/category/成員/share sum，REVOKE PUBLIC/anon execute，GRANT authenticated execute。request table INSERT ON CONFLICT DO NOTHING 後 SELECT FOR UPDATE；hash conflict 抛 domain exception，既有結果立即 replay，首次 insert expense 與 result snapshot 在同一 transaction 完成。quota 原子 increment WHERE count<100。直接 table mutation 不授予 caller；owner 可讀 request snapshot，原始文字不儲存；保留 tombstones。fixtures 與 migrations 分開，不把測試 expense schema 套正式環境。
- [ ] **Step 4: Run** integration tests PASS；確認 key collisions、rollback、RLS、snapshot privacy與 grant assertions。結果只證明該 disposable schema，不證明 production migration 已驗證。
- [ ] **Step 5: Commit** message `feat: enforce semantic request idempotency in Supabase`。

## Task 3: LangGraph service and Cloud Run container

**Interfaces:** `authenticate(token:string):Promise<{id:string,email:string}>`；`loadContext(user):Promise<SemanticContext>`；`lookupCompleted(requestId:string,inputHash?:string):Promise<CompletedResult|null>`；`persistExpense(requestId:string,inputHash:string,expense:ValidatedExpense):Promise<CompletedResult>` 全部 caller-scoped Supabase adapter。`extractEntry(text,context,signal):Promise<{raw:unknown,model:string,inputTokens:number|null,outputTokens:number|null}>`；`buildSemanticGraph(deps:GraphDependencies)` compile 的 graph input `{request:SemanticRequest,token:string}`、output SemanticResponse；`handleSemanticRequest(req:Request,deps):Promise<Response>`；GET status 使用相同 verified user，不呼叫模型。

- [ ] **Step 1: Write failing tests** graph/handler/provider：unauthed401、nonmember403、extra userId/hash400、quota429，全都 model/write calls=0；valid case model=1/persist=1、無 interrupt；rejected422/write0；existing replay model0/quota0/persist0；different hash409；provider refusal/invalid502、15s timeout504、no retries；persist timeout 回 uncertain error，不宣稱未新增。GET 跨 user 不洩漏 snapshot。log 沒有原文/email/token/expense。stub fetch 驗證 output cap800、reasoning none、schema、usage null preservation。
- [ ] **Step 2: Run** `npm --prefix services/semantic-entry test -- tests/graph.test.ts tests/handler.test.ts tests/provider.test.ts`，預期 FAIL。
- [ ] **Step 3: Implement graph/server**，nodes 對應 spec，模型无 tools，normalize 不合法走 terminal rejection。token 以 request-scoped closure 提供，不放 persisted graph state／traces。input hash 按 spec 算；context 後 lookup 成功就 replay，否則 consume quota→extract→validate→RPC。CORS origin allowlist／OPTIONS、body8KiB、HTTP deadline30s；POST/GET endpoint path固定 /semantic-entry，healthz 不做付費呼叫。Node HTTP server 讀 PORT（local8080），listen0.0.0.0；multi-stage Dockerfile npm ci/build/run non-root，不把 root .env 或 tokens 放 image。
- [ ] **Step 4: Run** backend tests/check；`docker build -f services/semantic-entry/Dockerfile -t jopie-semantic-entry .` 與 local container healthz、POST mock provider、GET status smoke tests。預期 healthz200、非法request400／missingtoken401。Cloud Run deployment doc 指定 request-based/min0/1vCPU/512MiB/max instances2，API secrets 用 Secret Manager，service account 僅取所需 secret；前端入口驗證 Supabase JWT，不能把 endpoint public 當授權。不部署／呼叫付費模型。
- [ ] **Step 5: Commit** message `feat: run automatic semantic entry with LangGraph`。

## Task 4: Submit once and show automatic result

**Interfaces:** `submitSemanticEntry(request:SemanticRequest,signal?:AbortSignal):Promise<SemanticResponse>`、`getSemanticEntryStatus(requestId:string,signal?:AbortSignal):Promise<CompletedResult|null>`；前端附 session JWT，PUBLIC_SEMANTIC_ENTRY_URL 指向 Cloud Run，response runtime validation。`SemanticEntryDialog` props `{open:boolean,onOpenChange:(open:boolean)=>void}`。

- [ ] **Step 1: Write failing Playwright tests** one click 後 created，沒有「確認記帳」；rejected 沒有 expense REST write；整個新流程 browser 不直接 POST expenses；double click 同 UUID一次inflight；timeout 重送維持 UUID/text；same text 新操作換 UUID；account switch 丟棄舊 UI result。created 首次 upsertOne 既有 store/cache；replayed 結果改用 refresh，避免舊snapshot覆寫編輯資料。GET result 可恢復不明結果；not_found 顯示仍未確認、不聲稱失敗；failure 顯示原因。關閉 dialog 不承諾取消 server write。
- [ ] **Step 2: Run** `BASE_PATH= npm run test:e2e -- e2e/semantic-entry.test.ts`，預期 FAIL。
- [ ] **Step 3: Implement UI** input/processing/created/rejected/uncertain states，按鈕「送出記帳」，uncertain 時「查詢結果」／「重試同一請求」；使用 revision/account guard。不新增 draft editor／前端 write；重送不能換 key或文字。成功資料使用既有 expensesStore.upsertOne，replay 用 forceRefetchMonthlyExpenses 對相關月份 refresh；錯誤／未完成保留原 input/key，但 tokens 不保存到額外 storage。
- [ ] **Step 4: Run** semantic/daily-carousel E2E、`npm run check`、`npm run lint`、`BASE_PATH=/expense-app npm run build`；預期 PASS，既有 failure 需記錄不默默修 unrelated code。另驗證 subpath入口、API URL與session傳遞，root E2E 不代替 subpath檢查。
- [ ] **Step 5: Commit** message `feat: submit semantic expenses without confirmation`。

## Task 5: Evidence, CI and handoff

**Interfaces:** `scoreCase(expected:CaseExpectation,raw:unknown,result:ValidationResult):CaseScore`、`summarize(scores:CaseScore[]):EvaluationSummary`；runner CLI `--mode fixture|live --runs 3 --max-calls 120 --out <directory>`，manifest包括 SHA/case hash/versions/mode/date/pricing；semantic live eval 不呼叫 persist 或 production DB。

- [ ] **Step 1: Write failing score tests** baseline/harness 用同raw；precision/recall denominators、zero eligible=N/A、unknown usage=null、120callcap、fixture非live、rejected不寫。建立40 cases、8類各5，人工作 expected status/fields/issues，涵蓋全部 spec defaults。
- [ ] **Step 2: Run** `npm --prefix services/semantic-entry test -- evals/score.test.ts`，預期 FAIL。
- [ ] **Step 3: Implement scorer/runner**，fixture不讀key／不做網路；live只呼叫 provider，各case3runs。backend scripts：test 排除 db.integration（另 test:integration）；eval:semantic=`tsx evals/run.ts --mode fixture --runs 3 --max-calls 120`；eval:semantic:live 同command mode live。manifest成本是 recorded usage×pricing assumptions，不是帳單；logs/eval artifacts只用synthetic資料。run outputs 加gitignore，review後summary才進 evidence。
- [ ] **Step 4: Run** `npm --prefix services/semantic-entry run eval:semantic -- --out /tmp/jopie-semantic-eval`，預期40IDs／120fixture observations；backend unit/integration/container、frontend E2E/check/lint/build與Markdown checks。付費 live command `npm --prefix services/semantic-entry run eval:semantic:live -- --out evals/runs/<run-id>` 只在另有授權時執行，未執行記unverified。
- [ ] **Step 5: Add CI and docs** 保留 Pages build，加入 backend npm ci/test/check、Docker build/smoke、disposable SQL integration、targeted Playwright與frontend checks；CI不含模型key／live eval。README新增commands/env與deployment link；architecture/database更新Cloud Run→HTTPS RPC、tables/grants、request lifetime；AGENTS擴充checks；evidence index列 source/mock/localDB/container/live/hosted 的各自證據與限制。Cloud Run hosted acceptance另列未執行項目，不能只憑Docker成功宣稱上線。
- [ ] **Step 6: Commit** message `test: record automatic entry harness evidence`。

## Completion and Execution Handoff

每個 task 都需 red→green tests 与獨立commit；必要工具缺失先報具體限制。正式expense schema、RLS、fallback category ID、GCP帳號/region/權限與預算在deploy前需確認。試用門檻與paid eval依spec；單一DB RPC是最終冪等保證，LangGraph／UI不是 exactly-once證明。

建議 Native execution：五個任務共享contract與RPC semantics，單一實作者降低交接成本；最後整體review。使用者也可選Subagent-driven。本次只更新計畫，選擇執行方式並review更新interfaces後才實作；不自動commit/push或deploy。

Self-review：全部預設值對應Task1；transaction／hash／user isolation／quota／tombstone對應Task2；graph／JWT／logging／container對應Task3；無人工介入與timeout/account handling對應Task4；evidence／門檻／CI對應Task5。五項Review Focus都有指定tests；已移除舊草稿確認與Edge Function方案。
