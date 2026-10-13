# Semantic entry execution decisions

Recorded in execution order; repeated boundaries reflect the final reviewer’s declined-to-judge list. The provisional Cloud Run interpretation was subsequently confirmed by the user. No minor findings were deferred.

1. Ruling: Work in the existing docs/semantic-entry-plan branch — user directed proceeding with additional changes after workspace question — cost if wrong: changes require transferring to another workspace.

2. Ruling: Use an explicitly disposable frontend-contract SQL fixture and mark migration production compatibility unverified — user authorized deferring current schema verification — cost if wrong: SQL requires revision before applying to production; no live database changes are authorized.

3. Ruling: Replay metadata describes replay handling, with null token usage and no invented original usage — completed snapshot interface contains only expense/replayed — cost if wrong: original model usage cannot be recovered from request snapshots.

4. Ruling: Preserve existing whole-repository lint failures and report them — baseline Prettier fails on 124 files; check has 0 errors and 6 warnings — cost if wrong: whole-repository lint remains red.

5. Task 2: Ruling: Local Supabase CLI 2.120.0 reproducibly aborts in the realtime migration container with OS monotonic time stepped backwards (exit 134) — use isolated PostgreSQL/PostgREST with synthetic Supabase auth helpers/JWTs for local transactional verification, retain full Supabase setup for Linux CI — cost if wrong: local results do not verify GoTrue or the complete Supabase bootstrap; production compatibility remains unverified.

6. Task 4: Ruling: Repair forceRefetchMonthlyExpenses with guarded direct paginated reads and replacement of the target month's rows/cache — the replay deletion test proved merge/cache-first refresh retains deleted expenses — cost if wrong: manual refresh now also reconciles deletions; pagination observes ordinary concurrent-read consistency, not a database snapshot.

7. Task 5: Ruling: Define the model-only baseline as a nonempty note/positive finite numeric amount proposal, and compare the same five common fields for both projections; report derived fields only for the harness — there is no separate baseline implementation in this repo — cost if wrong: this comparison measures the explicit projection/rule gate, not a competing product or live model quality.

8. Task 5: Ruling: CI runs explicit semantic-change lint rather than the failing whole-repository baseline, while local whole lint remains reported — avoid making new CI permanently red on 124 unrelated files — cost if wrong: CI does not establish whole-repository lint cleanliness.

9. Task 5: Ruling: Interpret GCP function as the already-approved Cloud Run container pending correction; add manual master-only deployment via OIDC, no IAM/database automation — user requested deployment code now and console IAM later — cost if wrong: an actual Functions Framework entry point/workflow must replace this container release path.

10. Final: Ruling: Production schema/triggers/RLS compatibility remains operator verification — user explicitly deferred current schema validation; fixture evidence is narrow — cost if wrong: production migration requires revision before release.

11. Final: Ruling: Paid model quality and trial thresholds remain unverified — no paid calls authorized — cost if wrong: fixture success may not translate to real extraction accuracy.

12. Final: Ruling: GCP IAM/public invocation/cold starts/release behavior remains operator setup and hosted acceptance — requested console setup follows code; workflow not executed — cost if wrong: first release may fail permissions/health or require resource tuning.

13. Final: Ruling: Full Supabase Linux bootstrap remains unverified — local clock failure forced synthetic PostgreSQL/PostgREST fallback — cost if wrong: CI bootstrap requires correction despite passing local SQL tests.

14. Final: Ruling: Existing non-account-scoped general caches remain outside this branch — new response guards are verified and a cache redesign is unrelated — cost if wrong: inherited cross-account cache behavior needs a separate fix.

15. Final: Ruling: Offset pagination uses ordinary concurrent-read consistency — accepted earlier fresh-refresh ruling; no transactional snapshot claimed — cost if wrong: a concurrent edit may require another refresh.

16. Final: Ruling: Persist unresolved UUID/text only in account-scoped browser localStorage, never tokens/server ledger/logs; require storage before submitting and clear definite results — actual page lifecycle recovery otherwise loses the idempotency key; user confirmed Cloud Run container — cost if wrong: unresolved description remains on that browser until resolved or site storage is cleared.
