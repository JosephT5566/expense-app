# Semantic entry evidence

Evidence is scoped to its environment. Local implementation and fixtures do not establish production database compatibility, hosted authentication, or paid model extraction quality.

## Development handoff — 2026-10-12

Local implementation is complete through commit `90938d0` on `docs/semantic-entry-plan`. This handoff reflects repository source and the recorded checks from that development session; tests were not rerun for this documentation update. No operator-reported production verification has been supplied. The user confirmed the Cloud Run container target.

| Plan task                 | Finished in the repository                                                                                                                | Remaining boundary                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. Shared contracts/rules | Portable DTO/runtime validation, Taiwan dates, defaults, integer amount/share checks                                                      | Real model extraction quality is not established by rule tests                                                            |
| 2. Idempotency/quota      | Draft SQL RPC, request snapshots, owner isolation, atomic quota, disposable integration tests                                             | Actual production expense schema/RLS/triggers/grants and fallback category must be checked before finalizing/applying SQL |
| 3. LangGraph service      | Auth/context/replay/quota/extract/validate/persist flow, HTTP API, provider limits, container and smoke harness                           | GCP deployment, cold starts, real auth and hosted behavior are unverified                                                 |
| 4. Frontend               | Automatic entry, reasons, same-key retry/status recovery, account guards, pending browser persistence, fresh replay refresh               | Production frontend-to-service acceptance remains unverified                                                              |
| 5. Evidence/CI            | 40 synthetic cases, scorer/runner, verification CI, manual Cloud Run release workflow, docs, whole-branch review and both Important fixes | GitHub workflow executions, full Linux Supabase bootstrap, paid evaluation and hosted acceptance have not run             |

Recorded final verification: 68 backend unit tests; 15 disposable SQL tests; container smoke; 22 full frontend tests; 18 semantic subpath tests; 40 case IDs/120 fixture observations/zero paid calls. Frontend type checking had zero errors/six existing warnings. Whole-repository lint failed on 122 existing formatting files; scoped formatting/ESLint passed. These counts are historical evidence, not new test results from the handoff update.

Next actions, in order:

1. Prepare GCP console resources/IAM, Secret Manager versions, and the GitHub `semantic-entry-production` environment using the [release setup guide](../../semantic-entry-deployment.md#github-actions-release). This can proceed alongside production schema review.
2. Obtain the current Supabase expense schema/policies/triggers/grants and category IDs; compare and finalize the draft migration. Applying it is a separate live database action.
3. Push/open a PR when authorized and let verification CI execute. Resolve any Linux Supabase/workflow failures; neither workflow is considered verified merely because its YAML parses.
4. After review/integration into `master`, verified database compatibility, and IAM/configuration readiness, authorize and manually trigger the Cloud Run release. Configure public invocation and verify health; then set `PUBLIC_SEMANTIC_ENTRY_URL` and release/rebuild Pages separately.
5. Perform hosted acceptance with a real authorized user, including retry/concurrency/replay/account isolation. Run paid synthetic live evaluation only with separate authorization; it never persists expenses. Record actual usage, quality and latency before declaring trial readiness.

No pushes, merges, IAM changes, production SQL changes, deployments, or paid calls have been performed by this development work. Existing lint debt and inherited general cache partitioning remain separate follow-up work.

| Evidence               | Scope                                                                                    | Status                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| Source/types           | Shared DTO validators, graph, provider, frontend, draft SQL                              | Repository-inspected                       |
| Unit/mock tests        | Rules, auth/replay/quota ordering, HTTP deadlines, provider payloads, evaluation scoring | Local checks recorded below                |
| Disposable SQL         | PostgreSQL 17/PostgREST with synthetic auth, transactional locking/rollback/grants       | Local verified; no deployed RLS claim      |
| Container smoke        | Real bundled HTTP server/graph with synthetic dependencies                               | Local verified; no provider/database calls |
| Browser E2E            | Mocked Supabase/semantic API; creation/cache/replay/retry/account switching              | Local verified; no live auth claim         |
| Fixture evaluation     | 40 authored raw fixtures, eight groups of five, three repeats                            | 120 observations; no paid calls            |
| Linux full Supabase CI | Real local GoTrue/PostgREST bootstrap                                                    | Workflow added; execution unverified       |
| GCP/OIDC deployment    | IAM, image push, Cloud Run release and health                                            | Workflow added; execution unverified       |
| Paid live evaluation   | Model quality, real usage/latency/cost estimates                                         | Not run; separate authorization required   |
| Hosted acceptance      | Actual schema/RLS, verified-user flow, deadlines/cold starts/budget                      | Not run                                    |

## Local record — 2026-10-12

Frontend implementation was committed as `9b585cb`. Before that commit, `npm run check` reported zero errors and six existing warnings; backend unit tests passed 61, disposable integration passed 15, and semantic subpath E2E passed 11. Earlier whole frontend suite passed 15. Whole `npm run lint` failed on the existing 124-file Prettier baseline; explicit changed-file formatting/ESLint passed. These are historical results. Fresh checks for the evidence/CI change: 68 backend unit tests and backend type/build checks passed; disposable integration passed 15; container smoke passed; full frontend E2E passed 15 with a fresh root-path build; frontend check reported zero errors/six existing warnings. A fresh `/expense-app` build plus semantic E2E passed 11. Whole-repository lint failed on 122 remaining Prettier files after formatting the touched documents/workflows; scoped semantic formatting/ESLint passed. Both new workflow YAML files parsed, shell/configuration checks accepted synthetic inputs and rejected four invalid configurations, and local Markdown link targets exist. Hosted workflow execution remains unverified.

The score tests first failed because the scorer module was missing; the cost test failed because `estimateCost` was absent, before implementation. Fixture evaluation produced 40 unique IDs and 120 observations with zero provider failures and zero paid calls. The model-only baseline is explicitly a nonempty-note/positive-finite-amount proposal with no rule gate. Both projections use the same raw fixture and the same five common fields; derived date/payer/shares/settlement fields are harness-only. This is not a comparison against another deployed application.

Fixture denominators: 45 eligible and 75 rejected observations. Harness eligibility precision/recall: 45/45 each; common fields: 225/225; derived fields: 180/180; exact rejection issue sets: 75/75; unsafe baseline proposals blocked: 57/57. Baseline eligibility precision: 45/102 and recall: 45/45. These deterministic results establish rule/scorer behavior for authored fixtures, not extraction accuracy on natural-language model outputs. Repeating fixtures adds no independent samples. Fixture latency measures local normalization/scoring, not provider or hosted latency. Usage and estimated cost are null because no provider measurement exists.

The runner writes `observations.json`, `summary.json`, and `manifest.json` into an ignored or explicitly chosen output directory. Manifest includes source HEAD, case hash, dependency/model/prompt versions, mode, run date, and recorded pricing assumptions. Source SHA identifies committed HEAD; if running with local modifications, it does not identify the entire working tree. Keep raw artifacts synthetic; review summaries before checking them in. Provider failures are separately reported and excluded from semantic quality denominators; an all-failed run cannot be treated as a successful rejection evaluation. The command exits nonzero on provider failures.

The local Supabase CLI aborted with a realtime-container monotonic-clock failure. The fallback tests do not verify GoTrue, the complete Supabase startup, or production migrations. The draft migration must be compared with the actual deployed schema, policies, triggers, grants, and defaults before use. No live database modifications, paid model calls, pushes, or deployments were performed for this implementation.

Setup and commands: [README](../../../README.md#semantic-expense-entry) and [deployment guide](../../semantic-entry-deployment.md). Source contracts: [database/service contracts](../../database.md#semantic-entry-service).

## Final review and recovery fixes

One fresh read-only whole-branch reviewer found two Important issues: a retry failure could erase earlier write uncertainty, and page lifecycle changes lost the pending UUID/text. Both were addressed in one fix pass. Seven browser regressions failed against the old build (three retry statuses, reload, navigation, blocked storage, and returning to the owning account), then passed in the full 22-test frontend suite. Fresh `/expense-app` build and semantic E2E also passed 18. Backend unit/type checks remained green at 68 tests; frontend check remained zero errors/six existing warnings. No Minor findings were reported.

Unresolved attempts now live in account-scoped browser localStorage without tokens, are restored as uncertain, and are removed after a definite result. This intentionally retains the description on that browser until completion or site-storage cleanup. Server ledgers/logs still do not store raw input text. Later rejection/provider/quota errors do not prove the original accepted operation failed.

The reviewer deferred production schema/RLS, paid model quality, hosted IAM/cold starts/release execution, Linux Supabase bootstrap, inherited general cache partitioning, and ordinary pagination consistency. Those boundaries remain explicit; no external acceptance claim follows from the review. See the [decision record](decisions.md) for all execution rulings and their costs.
