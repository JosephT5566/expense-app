# JoPie expense app

JoPie is a personal and household expense tracker built for Joseph and Pieda. It supports expense entry and editing, monthly category summaries, shared-expense settlement, scheduled and recurring expenses, and receipt import with AI-assisted review. The interface is primarily in Traditional Chinese.

The app uses Svelte 5, SvelteKit, TypeScript, and Supabase. It builds as a static site for GitHub Pages and includes PWA configuration through the Vite PWA plugin.

## Development

Use Node.js 22.12 or later within Node 22 to match CI, then install dependencies:

```sh
npm ci
```

Create a local `.env` with these values from your existing Supabase project and receipt service. This repository does not provision either service.

```dotenv
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
PUBLIC_EMAIL_NAME_MAPPING={"member@example.com":{"name":"Member","color":"#808080"}}
PUBLIC_GOOGLE_AI_GCF=https://your-receipt-service.example.com
# Optional: enable the separate semantic-entry service
PUBLIC_SEMANTIC_ENTRY_URL=https://your-semantic-service.run.app
BASE_PATH=
```

`PUBLIC_EMAIL_NAME_MAPPING` is a JSON object keyed by email for `allowedUserInfo` in `src/lib/stores/appSetting.store.ts`. The separate `getUserInfo` helper currently expects an array instead; verify its callers before changing that contract. `PUBLIC_*` values are included in client builds; use a Supabase publishable key, never a service-role key.

Enable Google OAuth in Supabase and allow the app's origin and base path as a redirect URL. The app expects the database objects described in [Database and service contracts](docs/database.md).

```sh
npm run dev
```

## Build and validation

| Command            | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `npm run check`    | Sync SvelteKit and check Svelte/TypeScript                 |
| `npm run lint`     | Check Prettier formatting and run ESLint                   |
| `npm run format`   | Format the repository in place                             |
| `npm run build`    | Build the static site into `build/`                        |
| `npm run preview`  | Preview the production build                               |
| `npm run test:e2e` | Run Playwright, which builds and starts the preview server |

The E2E suite includes daily carousel tests with mocked Supabase authentication and responses, covering date jumps, repeated swipes, month/year boundaries, bounded card rendering, DOM reuse within and across buffer shifts, date jumps during animation, empty months, and retrying failed loads. The original scaffold test still checks for a visible home-page `h1`. These tests do not verify live authentication or settlement workflows.

For a targeted carousel check, run `npm run test:e2e -- e2e/daily-carousel.test.ts`. Playwright needs its browser installed (`npx playwright install chromium`) and the build-time environment above. The suite builds and starts a preview server on port 4173. Keep `BASE_PATH` empty for the existing specs, which navigate to root paths; verify a deployment subpath separately.

For documentation-only changes, run `npx prettier --check <changed Markdown files>` and `git diff --check`, then verify local links and source references. Format only those files with `npx prettier --write <changed Markdown files>` if needed. Application builds and E2E runs are unnecessary for documentation-only changes.

For deployment under a repository subpath, set `BASE_PATH` to `/expense-app` (or the actual repository name) when building. Development uses an empty base path. GitHub Actions builds pull requests to `master` and deploys pushes to `master` or manual workflow runs to GitHub Pages, using environment values configured in the workflows.

The original Pages/build workflows remain. `semantic-entry-check.yml` adds backend unit/type checks, synthetic fixture evaluation, container smoke tests, disposable Supabase integration, frontend checks, explicitly scoped semantic-change lint, and root/subpath Playwright tests. It uses synthetic frontend configuration and no paid model key. Whole-repository `npm run lint` has existing Prettier failures; scoped CI lint does not establish whole-repository cleanliness. Python/browser wire parity is checked separately; it is not a generated-schema drift check. New hosted CI executions remain unverified until GitHub runs them.

`semantic-entry-deploy.yml` is a separate manual, `master`-only Cloud Run release workflow. It verifies the backend/container before using OIDC credentials, pushes to Artifact Registry, deploys an immutable digest, and checks `/healthz`. It does not configure IAM, apply SQL, deploy Pages, or run paid evaluations. See [deployment setup](docs/semantic-entry-deployment.md#github-actions-release).

## Agent workflow

[AGENTS.md](AGENTS.md) routes tasks to the existing context documents and defines product boundaries, verification by change type, and evidence reporting. The workflow is: read relevant context, confirm it against source, make a focused change, run applicable checks, update affected documentation, and hand off a reviewable diff with results and remaining limitations.

Documentation ownership stays with the existing files: setup, commands, and CI here; source responsibilities and data flow in [Architecture](docs/architecture.md); external/frontend contracts in [Database and service contracts](docs/database.md). These serve as current project context without a separate duplicate memory file. Reusable documentation maintenance lives in the [expense app guide skill](.agents/skills/expense-app-guide/SKILL.md); root instructions hold shared rules.

Report findings as `repository-verified`, `operator-reported`, or `unverified` according to the evidence available. Client types, comments, and mocked responses do not prove deployed Supabase policies or receipt-service behavior. Keep historical check outputs in task artifacts and distinguish them from checks run for the current change.

This is a local coding-agent workflow. No issue-to-PR agent automation is configured. The synthetic semantic-entry harness below evaluates local rules separately from live model quality.

## Project documentation

- [Architecture](docs/architecture.md): routes, module responsibilities, and data flow.
- [Database and service contracts](docs/database.md): frontend contracts and inherited Supabase notes.
- [Agent instructions](AGENTS.md): repository guidance and documentation maintenance rule.
- [Expense app guide skill](.agents/skills/expense-app-guide/SKILL.md): explain the app and update affected documentation.

## Semantic expense entry

The home page's「文字記帳」button sends a description to the Python/LangGraph service. Missing or repairable information prompts a focused follow-up question, up to three answers; a valid expense is written automatically and the saved row is shown without draft approval. The modal stays locked during submission and writing. Conversation content stays in modal memory and is discarded on close, account change, or page lifecycle changes. Only an unresolved request UUID is retained in account-scoped localStorage, without text or tokens. Retry uses the exact in-memory payload; after closing/reloading, only status lookup remains available. A missing status result or failed retry cannot erase earlier uncertainty. Storage failure blocks a new submission. Without `PUBLIC_SEMANTIC_ENTRY_URL`, submission reports that the service is not configured. Manual editing and receipt review remain separate workflows.

```sh
# Python 3.12 service; uv 0.12.7 matches CI/container tooling.
uv sync --project services/semantic-entry --locked
uv run --directory services/semantic-entry --locked pytest
uv run --directory services/semantic-entry --locked ruff check .
uv run --directory services/semantic-entry --locked ruff format --check .
uv run --directory services/semantic-entry --locked mypy
uv run --directory services/semantic-entry --locked python -m semantic_entry.evaluation --mode fixture --out /tmp/jopie-semantic-eval
# Cross-language check requires frontend Node 22.12+ and the Python .venv above.
node --experimental-strip-types packages/semantic-entry-contract/tests/python-parity.mjs
```

Fixture mode uses 40 synthetic cases, five in each of eight groups, repeated three times. It does not read the model key, contact a provider, or persist expenses. Its results measure the normalizer/scorer against authored raw outputs, not model extraction quality. Unknown usage/pricing remains null. For a separately authorized live evaluation, `uv run --directory services/semantic-entry --locked python -m semantic_entry.evaluation --mode live --out /tmp/jopie-semantic-live-eval` calls only the provider, caps attempts at 120, and never imports the persistence adapter. Optional cost assumptions use `SEMANTIC_INPUT_USD_PER_MILLION`, `SEMANTIC_OUTPUT_USD_PER_MILLION`, `SEMANTIC_PRICING_SOURCE`, and `SEMANTIC_PRICING_AS_OF`; estimates are not bills.

Disposable SQL setup, backend environment values, and release/IAM instructions are in [deployment setup](docs/semantic-entry-deployment.md). Verify the actual deployed expense schema/RLS and fallback category before applying the draft RPC. The checked-in test schema is synthetic and must never be applied to production.

For semantic browser tests, use `PUBLIC_SEMANTIC_ENTRY_URL=https://semantic.example.test npm run test:e2e -- e2e/semantic-entry.test.ts`. To verify the Pages path, also set `BASE_PATH=/expense-app E2E_BASE_PATH=/expense-app`. The carousel specs still expect root paths.

See the [中文 branch 開發紀錄](docs/evidence/semantic-entry/branch-notes.zh-TW.md), [evidence index](docs/evidence/semantic-entry/README.md), [design](docs/superpowers/specs/2026-10-11-semantic-expense-entry-design.md), and [implementation plan](docs/superpowers/plans/2026-10-11-semantic-expense-entry.md). Local implementation is available; production compatibility, paid model quality, and hosted acceptance remain unverified.
