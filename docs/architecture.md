# App architecture

JoPie is a SvelteKit frontend that accesses Supabase directly from the browser. This repository contains no application server routes, SQL migrations, or receipt-analysis backend. See [README.md](../README.md) for setup and [Database and service contracts](database.md) for external contracts.

## Source map

| Location                           | Responsibility                                                              |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `src/routes/`                      | File-based pages and shared layout                                          |
| `src/lib/components/`              | Expense list, editor, scheduled cards, and receipt dialog                   |
| `src/lib/components/ai-receipt/`   | Upload, analysis, preview editing, grouping, and confirmation               |
| `src/lib/components/ui/`           | Navigation, auth modal, date picker, calculator, and chart                  |
| `src/lib/components/shadcn/`       | UI primitives built around Bits UI                                          |
| `src/lib/data/`                    | Supabase fetchers, receipt API client, cache-first retrieval                |
| `src/lib/stores/`                  | Session, expenses, schedules, categories, filters, settings, theme          |
| `src/lib/cache/`                   | Memory and IndexedDB persistence for monthly and pending scheduled expenses |
| `src/lib/types/`                   | Expense, schedule, receipt API, user, category, settings contracts          |
| `src/lib/supabase/`                | Supabase client and Google OAuth/session helpers                            |
| `src/lib/utils/`                   | Taiwan dates/months, cache keys, loading, logging, icons, device detection  |
| `src/app.css`, `src/lib/theme.css` | Global styles and themes                                                    |
| `static/`                          | Icons, favicon, robots file                                                 |
| `.github/workflows/`               | Build check and Pages deployment                                            |
| `e2e/`                             | Playwright tests                                                            |

## Routes

| Route                  | Purpose                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `/`                    | Daily expenses, editor, due scheduled items, receipt import                                          |
| `/summary`             | Monthly category totals, chart, expense drill-down                                                   |
| `/settle`              | Query unsettled household expenses by date, calculate transfers for selected rows, mark them settled |
| `/scheduled`           | Manage one-time and recurring expenses; approve or skip due occurrences                              |
| `/search`              | Search expense notes with filters                                                                    |
| `/setting`             | Links to settlement, search, scheduling, and sign-out                                                |
| `/sentry-example-page` | Manual error-trigger page; its name does not establish a configured Sentry integration               |

## Startup and authentication

`src/routes/+layout.ts` skips fetching outside the browser. In the browser it gets the Supabase user, then expense categories and the settings allowlist. Its month comes from the `m` query parameter or the current Taiwan month.

`src/routes/+layout.svelte` initializes stores from load data, retrieves monthly expenses through the cache-first helper and merges them into the store so concurrent neighbouring-month loads are retained, loads pending schedules, and renders navigation and the auth modal. On mount it subscribes to auth changes through `src/lib/supabase/auth.ts`. Sign-out clears expense and scheduled stores, invokes cache cleanup, and navigates home.

Google sign-in redirects to the app's origin plus its SvelteKit base path. Database access depends on external RLS policies, not just frontend filters.

## Expense reads and writes

`src/lib/data/expenses.fetcher.ts` owns listing, note search, upsert, deletion, and settlement updates. Queries include the current user's personal rows and non-personal rows, with date, scope, and settled filters. Results are ordered by `ts` and `id` descending, but subsequent-page filtering currently uses only `ts`.

The expense store tracks loaded rows and pagination state. `ExpenseDrawerContent.svelte` writes through the fetcher, then updates the store. Single-row store upserts/deletes patch existing monthly cache entries, including removing an old-month row when its date moves across months. Bulk store upserts do not currently persist monthly cache patches.

Monthly retrieval checks memory, then IndexedDB, then Supabase. Cached months become stale after ten minutes; stale hits return immediately and launch background cache revalidation. That helper updates the cache without directly publishing refreshed rows into the expense store. Explicit refresh is implemented in `forceRefetchMonthlyExpenses`.

The home page renders a moving carousel window containing the selected date, the previous day, and the next day. At today, the future card is omitted. Swipes change the selected date after the animation settles, then recenter the window; the date input can jump to any past date. Expenses are grouped by Taiwan day once per store update and passed to the visible cards. The page loads the months represented by the window through the cache-first helper and tracks loading, success (including empty months), and failure per month for the current account. Failed loads show a retry action. This bookkeeping lasts for the home page instance; the summary still checks for existing rows before requesting a month. Monthly cache retrieval currently takes only the first page, up to 500 rows by default.

The summary groups loaded rows by category: personal rows contribute their full amount; household rows contribute the current user's `shares_json` amount. Settlement queries its own rows and calculates balances and transfers locally; it does not query the inherited monthly balance view described in the database notes.

## Scheduled expenses

The scheduled store retrieves pending rows through `scheduled-cache-first.ts`, using memory/IndexedDB caching and a 24-hour stale threshold. Due items are derived from pending rows and a clock updated every minute.

Mutations use `scheduled-expenses.fetcher.ts`. Approval creates a regular expense, then deletes a one-time schedule or advances a recurring schedule. The store updates regular expenses and the pending schedule cache. Recurrence supports daily, weekly, and monthly rules in `Asia/Taipei`. See [lifecycle details](database.md#scheduled-expenses).

## Receipt import

`AIReceiptImportDialog.svelte` coordinates upload, analysis, and confirmation. `UploadStep.svelte` validates images, converts HEIC/HEIF when needed, obtains signed upload URLs from the external service, uploads images, and requests analysis by file path.

`ai-receipt.fetcher.ts` attaches the Supabase session access token and adapts normalized responses into the extraction shape used by the review UI. Preview components support correction, grouping, and exclusion. `ConfirmStep.svelte` validates visible entries and bulk-upserts final expenses. See [service details](database.md#receipt-analysis-service).

## Styling, static build, and PWA

The app uses Tailwind CSS, DaisyUI, Bits UI, and shadcn-svelte primitives. Svelte stores and Svelte 5 runes both appear in the code.

`svelte.config.js` uses `adapter-static`, outputs to `build/`, sets `404.html` as fallback, and applies `BASE_PATH` outside development. Home, summary, settlement, search, and settings page modules export `prerender = true`. There is no explicit `ssr = false` export; browser-only data loading is guarded in the layout.

`vite.config.ts` configures the JoPie PWA manifest and prompt-based registration behavior. SvelteKit's automatic service-worker registration is disabled so the PWA plugin can manage registration. PWA support and browser caching do not make remote writes available offline.
