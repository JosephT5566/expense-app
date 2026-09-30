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

The E2E suite currently contains one scaffold test checking for a visible home-page `h1`; it does not validate expense, authentication, or settlement workflows.

For deployment under a repository subpath, set `BASE_PATH` to `/expense-app` (or the actual repository name) when building. Development uses an empty base path. GitHub Actions builds pull requests to `master` and deploys pushes to `master` or manual workflow runs to GitHub Pages, using environment values configured in the workflows.

## Project documentation

- [Architecture](docs/architecture.md): routes, module responsibilities, and data flow.
- [Database and service contracts](docs/database.md): frontend contracts and inherited Supabase notes.
- [Agent instructions](AGENTS.md): repository guidance and documentation maintenance rule.
- [Expense app guide skill](.agents/skills/expense-app-guide/SKILL.md): explain the app and update affected documentation.
