# App architecture

JoPie is a SvelteKit frontend that accesses Supabase directly from the browser. A separate Python 3.12/LangGraph service handles semantic entry through caller-scoped HTTPS Supabase RPC. The repository includes its container, captured public baseline, semantic migrations, and disposable fixtures; it contains no SvelteKit server routes or receipt-analysis backend. Live public-schema metadata and the trigger fix were verified on 2026-10-13; hosted service behavior and the remaining response/type alignment are unverified. See [README.md](../README.md) for setup and [Database and service contracts](database.md) for external contracts.

## Source map

| Location                            | Responsibility                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/routes/`                       | File-based pages and shared layout                                                                    |
| `src/lib/components/`               | Expense list, editor, scheduled cards, and shared AI entry dialog                                     |
| `src/lib/components/ai-receipt/`    | Upload, analysis, preview editing, grouping, and confirmation                                         |
| `src/lib/components/ui/`            | Navigation, auth modal, date picker, calculator, and chart                                            |
| `src/lib/components/shadcn/`        | UI primitives built around Bits UI                                                                    |
| `src/lib/data/`                     | Supabase fetchers, receipt API client, cache-first retrieval                                          |
| `src/lib/stores/`                   | Session, expenses, schedules, categories, filters, settings, theme                                    |
| `src/lib/cache/`                    | Memory and IndexedDB persistence for monthly and pending scheduled expenses                           |
| `src/lib/types/`                    | Expense, schedule, receipt API, user, category, settings contracts                                    |
| `src/lib/supabase/`                 | Supabase client and Google OAuth/session helpers                                                      |
| `src/lib/utils/`                    | Taiwan dates/months, cache keys, loading, logging, icons, device detection                            |
| `src/app.css`, `src/lib/theme.css`  | Global styles and themes                                                                              |
| `static/`                           | Icons, favicon, robots file                                                                           |
| `services/semantic-entry/`          | Python ASGI/LangGraph service, HTTPX Gemini provider/RPC, normalizer, tests, and synthetic evaluation |
| `packages/semantic-entry-contract/` | Portable request/response runtime validation and DTOs                                                 |
| `supabase/`                         | Captured public baseline, semantic migrations, and explicitly disposable fixtures                     |
| `.github/workflows/`                | Build/Pages, semantic verification, and manual Cloud Run release                                      |
| `e2e/`                              | Playwright tests                                                                                      |

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

Monthly retrieval checks memory, then IndexedDB, then Supabase. Cached months become stale after ten minutes; stale hits return immediately and launch background cache revalidation. That helper updates the cache without directly publishing refreshed rows into the expense store. Explicit refresh in `forceRefetchMonthlyExpenses` reads fresh 500-row pages, replaces the target month in cache/store (including deletions), and guards account/revision changes. These paginated reads are not a database snapshot.

The home page renders a buffered carousel with at most seven consecutive days: three days before and after a window anchor, excluding future dates (four cards when anchored at today). Swipes update the selected date when Embla selects a slide, reusing mounted cards inside the buffer. When moving within one card of an edge, the window shifts around the selected date after the animation settles; cards keyed by date preserve shared DOM nodes. The date input and Today button rebuild and center the buffer immediately, including when interrupting a swipe. Expenses are grouped by Taiwan day once per store update and passed to the visible cards. The page prepares the months in the seven-day buffer around the selected date through the cache-first helper, beginning during the swipe animation and tracks loading, success (including empty months), and failure per month for the current account. Failed loads show a retry action. This bookkeeping lasts for the home page instance; the summary still checks for existing rows before requesting a month. Monthly cache retrieval currently takes only the first page, up to 500 rows by default.

The summary groups loaded rows by category: personal rows contribute their full amount; household rows contribute the current user's `shares_json` amount. Settlement queries its own rows and calculates balances and transfers locally; it does not query the inherited monthly balance view described in the database notes.

## Semantic entry

`AIEntryDialog.svelte` owns the shared modal and its text/image mode switch. It opens in text mode, keeps both panels mounted to preserve progress across switches, and disables mode switching and closing during active requests. `semantic-entry/SemanticEntryContent.svelte` submits through `semantic-entry.fetcher.ts` with the current session JWT and one UUID for the logical expense. The optional bounded question/answer history lives only in modal memory. Missing or repairable fields produce a focused question; answers supplement the same expense, which the service writes automatically once valid. The UI locks closing, Escape, and outside interaction throughout submission, and shows the SSE `persisting` event before the RPC. No draft confirmation is involved. Closing a clarification discards the conversation and starts the next operation with a new UUID; account/revision guards discard stale results.

Before each submission, account-scoped localStorage retains only `{requestId}`, without text, history, or JWT. Definitive results clear it. An uncertain retry freezes the exact in-memory text/history/UUID; later errors or questions cannot erase earlier uncertainty. Closing, account changes, navigation, or reload discard that payload and leave only status lookup available for the owning account. Legacy pending records are reduced to UUID-only storage. New submissions require working recovery storage.

The separate service authenticates through Supabase `HTTPS `/auth/v1/user``, loads trusted settings/categories/member context and the Taiwan date, checks for a completed request, consumes quota only for new attempts, calls the provider once, normalizes, and persists via one SQL RPC. Completed replays skip the model and quota. Raw text and JWTs are not stored in the request ledger or persisted graph state; external payload tracing is disabled. See [semantic service contracts](database.md#semantic-entry-service).

First creation patches the existing expense store/cache. Replay/status recovery refreshes the snapshot month and any currently known row month instead of applying the old snapshot. The browser does not directly write expenses in this flow. Receipt import still requires its existing review/confirmation.

## Scheduled expenses

The scheduled store retrieves pending rows through `scheduled-cache-first.ts`, using memory/IndexedDB caching and a 24-hour stale threshold. Due items are derived from pending rows and a clock updated every minute.

Mutations use `scheduled-expenses.fetcher.ts`. Approval creates a regular expense, then deletes a one-time schedule or advances a recurring schedule. The store updates regular expenses and the pending schedule cache. Recurrence supports daily, weekly, and monthly rules in `Asia/Taipei`. See [lifecycle details](database.md#scheduled-expenses).

## Receipt import

`AIEntryDialog.svelte` hosts the two feature components: `semantic-entry/SemanticEntryContent.svelte` for text entry and `ai-receipt/ReceiptImportContent.svelte` for receipt import. The receipt component owns upload, analysis, preview state, confirmation, and cancellation; it exposes its busy state and close request to the shared dialog. Receipt progress is preserved when switching modes; closing discards progress, with cancellation confirmation after the upload step. `UploadStep.svelte` validates images, converts HEIC/HEIF when needed, obtains signed upload URLs from the external service, uploads images, and requests analysis by file path.

`ai-receipt.fetcher.ts` attaches the Supabase session access token and adapts normalized responses into the extraction shape used by the review UI. Preview components support correction, grouping, and exclusion. `ConfirmStep.svelte` validates visible entries and bulk-upserts final expenses. See [service details](database.md#receipt-analysis-service).

## Styling, static build, and PWA

The app uses Tailwind CSS, DaisyUI, Bits UI, and shadcn-svelte primitives. Svelte stores and Svelte 5 runes both appear in the code.

`svelte.config.js` uses `adapter-static`, outputs to `build/`, sets `404.html` as fallback, and applies `BASE_PATH` outside development. Home, summary, settlement, search, and settings page modules export `prerender = true`. There is no explicit `ssr = false` export; browser-only data loading is guarded in the layout.

`vite.config.ts` configures the JoPie PWA manifest and prompt-based registration behavior. SvelteKit's automatic service-worker registration is disabled so the PWA plugin can manage registration. PWA support and browser caching do not make remote writes available offline.

The Python backend lives in `services/semantic-entry/semantic_entry/`, uses FastAPI/Uvicorn for HTTP and HTTPX for caller-scoped Supabase and provider requests, and locks dependencies in `uv.lock`. Its strict Python validators mirror the browser TypeScript contract; `packages/semantic-entry-contract/tests/python-parity.mjs` compares normalized requests/hashes and validates real synthetic JSON/SSE HTTP outputs. FastAPI registers explicit health, creation, and status routes, followed by a fallback route that preserves the existing CORS preflight and JSON errors for unknown paths or methods. Request bodies are read directly and validated by the portable validators; automatic OpenAPI, Swagger UI, and ReDoc endpoints are disabled. The lifespan owns the shared HTTPX client and closes it on shutdown. No Node runtime or frontend source is included in the Python container.

Gemini analysis uses an optional provider streaming method and `on_analysis` callback through the existing LangGraph `extract` node and handler Queue. The graph retains `ainvoke`, normalization, fixed clarification questions, and persistence branches. The provider envelope contains only `analysis` and `extraction`; analysis stays outside graph state and persisted data.

The semantic fetcher requests version 2 SSE and validates analysis request IDs, sequential sequence numbers, event order, and a 200-code-point cumulative cap before updating the dialog. Old backends without analysis events remain compatible. The dialog displays user messages on the right and assistant analysis, clarification questions, and results on the left, with the composer below a scrollable conversation. It follows streaming updates while the reader is near the bottom. Analysis stays outside the live status region; each clarification round preserves the previous summary in the in-memory conversation while resetting the active summary. Display messages are separate from the bounded request history and are never sent to the service. New operations, closing, account changes, and page lifecycle events discard the display conversation. Status queries clear the active summary.
