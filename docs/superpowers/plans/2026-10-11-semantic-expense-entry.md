# Semantic Expense Entry Implementation Plan

> Historical Node execution status (2026-10-12): local implementation of Tasks 1–5 and final review fixes is complete through `90938d0`. The step checkboxes below preserve the original plan; they are not the current progress tracker. Production SQL compatibility, GitHub/GCP execution, paid model evaluation, and hosted acceptance remain unverified. See the [development handoff](../../evidence/semantic-entry/README.md#development-handoff--2026-10-12) for finished work, remaining boundaries, recorded checks, and next actions. Cloud Run container is confirmed; IAM setup follows code review.

> Python migration (2026-10-12): backend runtime, adapters, graph, evaluation, tests, Docker and CI have been migrated to Python. The original task checklist below is historical Node implementation context, not instructions for the Python migration. This migration does not use the superpowers plugin. Current commands and scope are in the [deployment guide](../../semantic-entry-deployment.md) and [Python migration record](../../evidence/semantic-entry/README.md#python-migration--2026-10-12).

**Goal:** 送出一句文字後自動新增一筆支出，透過 Supabase RPC 保證同一請求不重複寫入，並建立 product harness evidence。

**Architecture:** Python 3.12 Starlette/Uvicorn HTTP service 與 Python LangGraph library 包裝為 Cloud Run serverless container。後端驗證 Supabase JWT、解析／驗證，再透過 HTTPS RPC 在單一 transaction 新增 expense 並保存 request 結果。前端只送出與顯示結果；沒有確認草稿或直接 expense write。

**Tech Stack:** 前端維持 Svelte 5、SvelteKit、TypeScript、Supabase JS、Playwright。Backend 改用 Python 3.12、Starlette/Uvicorn、HTTPX、LangGraph、pytest/pytest-asyncio、Ruff、mypy；獨立 `pyproject.toml` 與 `uv.lock` 管理依賴。Docker 與 CI 使用 uv 0.12.7。前端 TypeScript contract 保留，Python mirror 透過 request/hash/HTTP response parity 驗證。沒有新增 direct DB connection、queue、Redis 或付費 LangSmith 部署。

**Spec:** [更新設計](../specs/2026-10-11-semantic-expense-entry-design.md)，更新於 2026-10-12。已採 inline execution 完成本機實作及 review fixes；正式部署尚未執行，驗證範圍見 development handoff。

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

## Clarification flow implementation — 2026-10-12

User-approved behavior: no editable draft or confirmation step. Insufficient/repairable information triggers a concrete Traditional Chinese question. Each answer continues the same expense; complete valid information automatically invokes the existing expense RPC and returns its actual row. Unsupported intents, configuration errors and malformed model output remain terminal failures. No conversation table, persistent graph/checkpointer, or separate agent endpoint is introduced. This work does not use the superpowers plugin.

### Contracts and lifetime

- Keep `{requestId,text}` compatible. Add optional `history:[{question,answer}]` (up to three follow-up answers); initial text/each answer <=500 trimmed Unicode code points, each question <=300. All strings are NFC-normalized; HTTP body remains <=8 KiB. History is untrusted user data, not system/assistant instructions. Fresh authentication, allowlist and context checks apply to every round.
- The same frontend-generated UUID identifies one logical expense throughout clarification. Questions do not create ledger rows or expenses; each new model round consumes quota. No automatic model retries. The graph emits `needs_input` with validated issues and a deterministic focused question when all issues are repairable. At the follow-up bound it returns terminal rejection. The provider still extracts one structured expense, using the initial description and supplied corrections.
- Preserve v1 hashes for requests without history; use a versioned canonical JSON payload hash for nonempty history. Every final retry freezes the complete normalized request. Existing caller-scoped `(user_id,request_id)` RPC uniqueness and conflict behavior remain the write boundary; no SQL migration is required.
- Clarification history exists only in modal memory and is discarded on close/account switch/navigation/reload. Persist only `{requestId}` in account-scoped pending storage before submission because any round may write. Clear it after a definite needs_input/rejection/failure/completion. Uncertainty from an earlier submission cannot be cleared by a later needs_input/rejection/error. Preserve exact retry payload only while in memory; after disposal offer status lookup only. Existing legacy pending records are read for their UUID and discarded text is not restored.

### Transport and UI

- POST with `Accept:text/event-stream` receives SSE `persisting`, then one terminal `result` or `error` event. Terminal results can be needs_input/created/rejected; GET status remains JSON. JSON POST remains available for compatibility and harnesses.
- Emit persisting only after complete validation, immediately before RPC. Stream disconnect before persist can cancel parsing; after persist begins the in-flight operation continues independently of the response stream within its deadline. No write is promised to be cancellable or certain after deadline/process termination.
- Lock modal Close/Escape/outside interactions from the moment each POST is submitted (avoids the notification race), show processing then writing, and unlock on needs_input/result/error. Account changes and page lifecycle still discard stale UI updates. Timeout releases the lock into uncertain recovery; never permanently lock.
- Show initial input, transient question/answer history, and a reply input. No confirmation button or draft editor. Created notifications show the actual saved note, amount, date and shares. Replay refresh retains existing edited/deleted snapshot behavior.

### Implementation checklist

- [x] Extend TypeScript/Python validators, canonical hashing and cross-language parity cases.
- [x] Add deterministic clarification policy and conversational extraction input to graph/prompt; retain quota/replay/order/validation guarantees.
- [x] Add bounded SSE transport, persisting event and disconnect/write lifetime tests.
- [x] Add frontend stream validation, close guards, transient chat, UUID-only recovery and no-draft automatic writes.
- [x] Cover complete-input creation, missing/ambiguous fields, repairs, limits, exact retries, changed-payload conflicts, stream faults, close/reload/account isolation and no browser expense writes.
- [x] Run Python pytest/Ruff/mypy, fixture evaluation, parity, Docker smoke, frontend check/lint, semantic root/subpath Playwright and Pages build. SQL unchanged; existing disposable SQL evidence is historical unless rerun.
- [x] Update current docs and scoped evidence; leave production SQL/IAM/deployment/paid model calls unverified and unperformed.

### Repository verification — 2026-10-12

- `uv run --directory services/semantic-entry --locked pytest -q`: 107 unit/mock tests passed. Includes clarification limits, no-write questions, final-payload hashes/conflicts, structured-log privacy, event ordering, and generator disconnect behavior before/after persistence. The checked-in SQL and dependencies were unchanged, so disposable SQL integration was not rerun; previous SQL fixture evidence is historical.
- `uv run --directory services/semantic-entry --locked ruff check .`, `ruff format --check .`, and `mypy semantic_entry`: passed (12 typed source files). Fixture evaluation (`python -m semantic_entry.evaluation --mode fixture --out /tmp/jopie-clarification-eval`): 40 cases, 120 observations, zero failures and zero paid calls. Fixture scoring tests normalization; real conversational model quality remains unverified.
- `node --experimental-strip-types packages/semantic-entry-contract/tests/python-parity.mjs`: 16 request/hash cases, five synthetic JSON HTTP responses, and three actual ASGI SSE events passed, plus malformed response/event checks.
- `docker build -f services/semantic-entry/Dockerfile -t jopie-semantic-entry .` and `services/semantic-entry/scripts/container-smoke.sh`: passed with synthetic dependencies; real Uvicorn handled history and SSE persisting → created. This is localhost container wiring evidence, not hosted proxy/disconnect durability evidence.
- `npm run check`: zero errors and six existing warnings. `npm run lint` failed at Prettier with 122 existing files; whole-repository lint is not passed. Explicit ESLint/Prettier checks passed for the changed contract, parity script, fetcher, component, browser tests, and Markdown. Changed Markdown local links and `git diff --check` passed.
- Root `npm run test:e2e -- e2e/semantic-entry.test.ts`: 26 passed using synthetic public configuration and local Chromium. Covers real incremental local HTTP SSE, fragmented CRLF/UTF-8, close guards, malformed/mismatched streams, same-ID clarification, exact retries, UUID-only lifecycle recovery, account isolation, and zero browser expense REST writes.
- Pages subpath `BASE_PATH=/expense-app E2E_BASE_PATH=/expense-app npm run test:e2e -- e2e/semantic-entry.test.ts`: 26 passed. Playwright's web-server command completed the Pages-base-path build before browser navigation/session and semantic-flow verification.
- **Unverified/operator work:** deployed SQL/RLS, hosted CI, real model clarification quality, hosted SSE buffering/disconnect behavior, and production Cloud Run/instance lifecycle. No live model call, production database change, deployment, or push was performed. Validate these in hosted acceptance before release.

## Database adoption update — 2026-10-13

The user-designated Supabase project was linked in an isolated CLI workspace. Existing public schema was captured without data; existing semantic objects matched the original migration, so baseline and original semantic versions were recorded as applied rather than replayed. A locally reproduced trigger citext-resolution failure was fixed by `202610130001_semantic_trigger_citext.sql` and applied. Local/remote migration history now matches and final dry-run reports no pending changes. See [scoped database evidence](../../evidence/semantic-entry/2026-10-13-database-baseline.md).

- [x] Capture public baseline, including actual extension dependencies, without expense/member/category data.
- [x] Verify full chain and share trigger locally; compare live metadata; adopt existing history and apply only the verified trigger fix.
- [x] Add local full-chain test and manual migration workflow with default dry-run and baseline/target checks.
- [ ] Align service `meta` adaptation with actual JSONB output and the safe integer bound with `numeric(12,2)` capacity; verify configured fallback category.
- [ ] Configure GitHub migration environment/secrets and perform an authorized hosted workflow run; service/auth/SSE/model acceptance remains outstanding.

Earlier evidence sections retain their historical scope. The migration workflow has not run on GitHub, and no production expense RPC or paid model call was executed during database adoption.

## Current Python service structure

| Files                                                                                                                         | Responsibility                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `services/semantic-entry/{pyproject.toml,uv.lock,.python-version,Dockerfile,Dockerfile.dockerignore}`                         | Python dependency lock, non-root container, source allowlist                                                |
| `services/semantic-entry/semantic_entry/{contracts,clarification,normalize,prompt,provider,supabase,graph,handler,server}.py` | Strict wire mirror, Taiwan rules, single model call, caller JWT HTTPS adapter, LangGraph, bounded ASGI HTTP |
| `services/semantic-entry/semantic_entry/evaluation.py`, `evals/cases.json`                                                    | Same 40 synthetic cases, bounded fixture/live runner, scorer and manifest                                   |
| `services/semantic-entry/tests/test_*.py`                                                                                     | Python unit/mock and localhost-only disposable SQL tests                                                    |
| `packages/semantic-entry-contract/tests/python-parity.mjs`, `services/semantic-entry/tests/export_contract.py`                | Actual Python outputs validated by the browser's TypeScript contract                                        |
| `services/semantic-entry/scripts/{container-smoke.sh,smoke-server.py,smoke-client.py,local-db.sh}`                            | Synthetic container smoke and disposable SQL setup                                                          |
| `.github/workflows/semantic-entry-{check,deploy}.yml`                                                                         | Python checks/container verification; existing manual Cloud Run release boundary                            |

## Python migration acceptance

- [x] Preserve POST/GET routes, UUID/NFC/hash, issue/error codes and response fields.
- [x] Preserve Taiwan date/default/split rules, safe integer bounds, explicit nullable fields.
- [x] Preserve verified-user/allowlist/replay/quota ordering and caller JWT RPC.
- [x] Preserve model cap 800, reasoning none, deadline 15 seconds, no retries; HTTP deadline 30 seconds, body 8 KiB, CORS and no-store.
- [x] Port fixture/live evaluation, local-only SQL harness and container smoke to Python.
- [x] Remove Node backend build/dependency files; frontend remains TypeScript.
- [x] Update CI, current setup/contracts/architecture and record scoped verification.
- [ ] Operator verification: production SQL/RLS, hosted CI/GCP/IAM, paid model quality and hosted acceptance.

## Historical Node implementation checklist

The following Tasks 1–5 describe the original implementation and its historical commands. They are retained to explain the design/review criteria; use the current Python commands above and in the README for new work. Historical Node paths have been replaced by the Python structure above.

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

建議 Native execution：五個任務共享contract與RPC semantics，單一實作者降低交接成本；最後整體review。使用者也可選Subagent-driven。以上為原始執行交接說明；本次實作已完成並提交本機 commits。後續 push／merge、正式 SQL 變更及部署仍需各自授權，目前進度以文件頂部的 development handoff 為準。

Self-review：全部預設值對應Task1；transaction／hash／user isolation／quota／tombstone對應Task2；graph／JWT／logging／container對應Task3；無人工介入與timeout/account handling對應Task4；evidence／門檻／CI對應Task5。五項Review Focus都有指定tests；已移除舊草稿確認與Edge Function方案。

## 2026-10-13 分類規則更新

依最新需求，不再使用 fallback category。Model 未能可靠判定既有 expense category 時回傳 null，service 回詢、不寫入；有效既有分類確認後才進入 persisting／RPC。未知或空白分類同樣回詢，最多三輪回答仍未解決則拒絕。移除 `SEMANTIC_OTHER_CATEGORY_ID` 與 context 的 `otherCategoryId`，無新增 migration。這段更新取代前述預設其他分類的設計。

## 2026-10-13 Gemini provider 更新

LLM 改為 Gemini Developer API generateContent，預設 gemini-3.5-flash-lite，模型由 SEMANTIC_MODEL 設定；部署使用 SEMANTIC_GEMINI_SECRET 綁定 GEMINI_API_KEY。舊 OpenAI 設定為歷史設計。本次保留服務回詢、SSE、JWT、quota 與 idempotent RPC；驗證使用 mocks／fixtures，不呼叫付費模型。
