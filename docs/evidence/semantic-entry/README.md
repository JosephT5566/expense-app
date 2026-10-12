# Semantic entry evidence

Evidence is scoped to its environment. Local implementation and fixtures do not establish production database compatibility, hosted authentication, or paid model extraction quality.

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
