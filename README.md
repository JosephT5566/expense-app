# JoPie expense app

JoPie is a personal and household expense tracker built for Joseph and Pieda. It supports expense entry and editing, monthly category summaries, shared-expense settlement, scheduled and recurring expenses, and receipt import with AI-assisted review. The interface is primarily in Traditional Chinese.

The app uses Svelte 5, SvelteKit, TypeScript, and Supabase. It builds as a static site for GitHub Pages and includes PWA configuration through the Vite PWA plugin.

## Development

Use Node.js 22 to match CI, then install dependencies:

```sh
npm ci
```

Create a local `.env` with these values from your existing Supabase project and receipt service. This repository does not provision either service.

```dotenv
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
PUBLIC_EMAIL_NAME_MAPPING={"member@example.com":{"name":"Member","color":"#808080"}}
PUBLIC_GOOGLE_AI_GCF=https://your-receipt-service.example.com
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

CI currently runs `npm ci` and `npm run build`; it does not run Svelte/TypeScript checks, lint, or Playwright. A green build workflow therefore establishes build success only. There is no backend test suite, checked-in database provisioning, or generated-contract drift check in this repository.

## Agent workflow

[AGENTS.md](AGENTS.md) routes tasks to the existing context documents and defines product boundaries, verification by change type, and evidence reporting. The workflow is: read relevant context, confirm it against source, make a focused change, run applicable checks, update affected documentation, and hand off a reviewable diff with results and remaining limitations.

Documentation ownership stays with the existing files: setup, commands, and CI here; source responsibilities and data flow in [Architecture](docs/architecture.md); external/frontend contracts in [Database and service contracts](docs/database.md). These serve as current project context without a separate duplicate memory file. Reusable documentation maintenance lives in the [expense app guide skill](.agents/skills/expense-app-guide/SKILL.md); root instructions hold shared rules.

Report findings as `repository-verified`, `operator-reported`, or `unverified` according to the evidence available. Client types, comments, and mocked responses do not prove deployed Supabase policies or receipt-service behavior. Keep historical check outputs in task artifacts and distinguish them from checks run for the current change.

This is a local coding-agent workflow. No issue-to-PR agent automation or formal harness scenario evaluation is configured. Adding either requires JoPie-specific checks and environment setup; the English Learning backend, training workflow, and API generation commands do not apply here.

## Project documentation

- [Architecture](docs/architecture.md): routes, module responsibilities, and data flow.
- [Database and service contracts](docs/database.md): frontend contracts and inherited Supabase notes.
- [Agent instructions](AGENTS.md): repository guidance and documentation maintenance rule.
- [Expense app guide skill](.agents/skills/expense-app-guide/SKILL.md): explain the app and update affected documentation.

## Planned work

- Semantic expense entry and product harness evidence: [design draft](docs/superpowers/specs/2026-10-11-semantic-expense-entry-design.md) and [implementation plan](docs/superpowers/plans/2026-10-11-semantic-expense-entry.md). The current direction is automatic creation via LangGraph on GCP Cloud Run, with Supabase HTTPS RPC enforcing transactional idempotency. The plan is ready for execution review; the feature is not implemented.
