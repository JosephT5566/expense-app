# App architecture

JoPie is a SvelteKit frontend that accesses Supabase directly from the browser. A separate Python 3.12/LangGraph service handles semantic entry through caller-scoped HTTPS Supabase RPC. The repository includes its container, captured public baseline, semantic migrations, and disposable fixtures; it contains no SvelteKit server routes. Receipt image analysis is implemented in the semantic-entry service. Live public-schema metadata and the trigger fix were verified on 2026-10-13; hosted service behavior and the remaining response/type alignment are unverified. See [README.md](../README.md) for setup and [Database and service contracts](database.md) for external contracts.

## Source map

| Location                             | Responsibility                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/routes/`                        | File-based pages and shared layout                                                                    |
| `src/lib/components/`                | Expense list, editor, scheduled cards, and shared AI entry dialog                                     |
| `src/lib/components/semantic-entry/` | Text/image conversation, draft editing, grouping, and confirmation                                    |
| `src/lib/components/ui/`             | Navigation, auth modal, date picker, calculator, and chart                                            |
| `src/lib/components/shadcn/`         | UI primitives built around Bits UI                                                                    |
| `src/lib/data/`                      | Supabase fetchers, semantic API/upload client, cache-first retrieval                                  |
| `src/lib/stores/`                    | Session, expenses, schedules, categories, filters, settings, theme                                    |
| `src/lib/cache/`                     | Memory and IndexedDB persistence for monthly and pending scheduled expenses                           |
| `src/lib/types/`                     | Expense, schedule, user, category, settings contracts                                                 |
| `src/lib/supabase/`                  | Supabase client and Google OAuth/session helpers                                                      |
| `src/lib/utils/`                     | Taiwan dates/months, cache keys, loading, logging, icons, device detection                            |
| `src/app.css`, `src/lib/theme.css`   | Global styles and themes                                                                              |
| `static/`                            | Icons, favicon, robots file                                                                           |
| `services/semantic-entry/`           | Python ASGI/LangGraph service, HTTPX Gemini provider/RPC, normalizer, tests, and synthetic evaluation |
| `packages/semantic-entry-contract/`  | Portable request/response runtime validation and DTOs                                                 |
| `supabase/`                          | Captured public baseline, semantic migrations, and explicitly disposable fixtures                     |
| `.github/workflows/`                 | Build/Pages, semantic verification, and manual Cloud Run release                                      |
| `e2e/`                               | Playwright tests                                                                                      |

## Routes

| Route                  | Purpose                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `/`                    | Daily expenses, editor, due scheduled items, AI entry                                                |
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

`AIEntryDialog.svelte` hosts one `semantic-entry/SemanticEntryContent.svelte` conversation with text and receipt image attachments, without a mode switch. The component validates images, converts HEIC/HEIF with `heic2any`, obtains signed URLs through `semantic-entry.fetcher.ts`, uploads bytes without the session JWT, and submits paths in v3 `analyze`. A single complete result writes directly; image analysis with multiple or incomplete results returns editable drafts. Pure text analysis retains the existing bounded clarification flow and automatic single-expense creation. The UI blocks closing, Escape, and outside interaction during requests; account/revision guards discard stale results.

`DraftBlock.svelte` displays the current drafts inline. Users can continue with text (`revise`), or enter `DraftEditDialog.svelte` to edit through the shared `ExpenseDrawerContent.svelte` draft mode, merge, ungroup, hide, or restore entries. Draft editing stays local. Only visible entries are submitted by 「全部記帳」 (`commit`), enabled when all are complete; the service independently validates values before batch persistence. `revise` never writes expenses. Drafts, conversation history, and attachment previews stay in modal memory.

Before analyze or commit submission, `pending.ts` saves an account-scoped localStorage v2 list `{v:2,items}`. Items contain only `requestId`, `submittedAt`, `kind`, `expiredAt`, and optional analyze `snippet`/`imageCount` or commit `draftCount`. The snippet is the first 12 Unicode code points of user text, a privacy tradeoff visible on shared devices; full text, history, analysis, image paths, draft contents, amounts, and tokens remain outside storage. Legacy UUID-only records migrate to expired `legacy` items. Only unexpired items count toward the limit of three. A status `not_found` expires an item only after ten minutes from submission; failed lookups and clock rollback do not expire it. Definitive results remove their item. Pending results allow new input, while requests and image conversion still lock interaction.

`PendingTray.svelte` renders the pending list as a title-bar badge and popover inside the AI entry dialog header; `SemanticEntryContent.svelte` passes it to `AIEntryDialog.svelte` through a bindable `header` snippet and owns all state. Rows expand in place to query status (`GET /semantic-entry/:requestId`), retry the retained in-memory attempt, or delete. Delete always re-queries first: `completed` applies the result, a failed lookup keeps the item, and `not_found` opens an alert dialog before removal. Lookups run on dialog open, account restore, tray open, row expand, and a 60-second interval; expired rows seen during a tray opening are removed from storage when the tray closes. Escape and outside clicks close only the popover; tray actions are disabled while a request streams. The three-item cap shows a four-second polite status toast without clearing input. An interrupted commit removes the draft block and opens the tray with that item expanded.

Only failures after a received `persisting` event become uncertain, even if a service error says `uncertain:true`. A lost event can misclassify a write; exact same-ID retries rely on service idempotency, while changed input can duplicate an expense. Unchanged failed text requests and commits reuse their ID and reference date; a commit keeps its identity across an intervening revise, failed or successful, until the normalized drafts change or a final result is confirmed. Image analysis after a pre-persisting failure requires selecting images again and uses a new ID. Uncertain retries preserve exact payloads in an in-memory request map through modal close; reload or account change leaves only status lookup. Account-change pruning subscribes to the user store at module level, so it also runs while the dialog is closed. Revise never enters the pending list. New submissions require working recovery storage. `timeouts.ts` gives text/revise/commit 45 seconds and image analyze 95 seconds, using the service deadline plus 15 seconds capped at Cloud Run plus 5 seconds. Service deadline changes must update those constants.

The separate service authenticates through Supabase `HTTPS `/auth/v1/user``, loads trusted settings/categories/member context and the Taiwan date, checks for a completed request, consumes quota only for new attempts, calls the provider once, normalizes, and persists via one SQL RPC. Completed replays skip the model and quota. Raw text and JWTs are not stored in the request ledger or persisted graph state; external payload tracing is disabled. See [semantic service contracts](database.md#semantic-entry-service).

First creation patches the existing expense store/cache. Replay/status recovery refreshes the snapshot month and any currently known row month instead of applying the old snapshot. The browser does not directly write expenses in this flow. Draft commit results use the same store/cache integration.

## Scheduled expenses

The scheduled store retrieves pending rows through `scheduled-cache-first.ts`, using memory/IndexedDB caching and a 24-hour stale threshold. Due items are derived from pending rows and a clock updated every minute.

Mutations use `scheduled-expenses.fetcher.ts`. Approval creates a regular expense, then deletes a one-time schedule or advances a recurring schedule. The store updates regular expenses and the pending schedule cache. Recurrence supports daily, weekly, and monthly rules in `Asia/Taipei`. See [lifecycle details](database.md#scheduled-expenses).

## Styling, static build, and PWA

The app uses Tailwind CSS, DaisyUI, Bits UI, and shadcn-svelte primitives. Svelte stores and Svelte 5 runes both appear in the code.

`svelte.config.js` uses `adapter-static`, outputs to `build/`, sets `404.html` as fallback, and applies `BASE_PATH` outside development. Home, summary, settlement, search, and settings page modules export `prerender = true`. There is no explicit `ssr = false` export; browser-only data loading is guarded in the layout.

`vite.config.ts` configures the JoPie PWA manifest and prompt-based registration behavior. SvelteKit's automatic service-worker registration is disabled so the PWA plugin can manage registration. PWA support and browser caching do not make remote writes available offline.

The Python backend lives in `services/semantic-entry/semantic_entry/`, uses FastAPI/Uvicorn for HTTP and HTTPX for caller-scoped Supabase and provider requests, and locks dependencies in `uv.lock`. Its strict Python validators mirror the browser TypeScript contract; `packages/semantic-entry-contract/tests/python-parity.mjs` compares normalized requests/hashes and validates real synthetic JSON/SSE HTTP outputs. FastAPI registers explicit health, creation, and status routes, followed by a fallback route that preserves the existing CORS preflight and JSON errors for unknown paths or methods. Request bodies are read directly and validated by the portable validators; automatic OpenAPI, Swagger UI, and ReDoc endpoints are disabled. The lifespan owns the shared HTTPX client and closes it on shutdown. No Node runtime or frontend source is included in the Python container.

Gemini analysis uses an optional provider streaming method and `on_analysis` callback through the existing LangGraph `extract` node and handler Queue. The graph retains `ainvoke`, normalization, fixed clarification questions, and persistence branches. The pure text provider envelope contains only `analysis` and `extraction`; analysis stays outside graph state and persisted data. Image/revise extraction uses `draft_provider.py` and `graph_v3.py`, without analysis callbacks; commit validates values without a model call.

The semantic fetcher requests version 3 SSE and validates analysis request IDs, sequential sequence numbers, event order, and a 200-code-point cumulative cap before updating the dialog. Deploy the v3 service before releasing this frontend. The dialog displays user messages on the right and assistant analysis, clarification questions, and results on the left, with one persistent textarea and an icon send button below a scrollable conversation. The same composer accepts the initial description and clarification replies, with accessible labels for each; phase-specific hints and the active character count sit immediately above it. Processing and terminal phases disable the composer. Recovery, retry, edit, and new-operation actions appear in the assistant result bubble. There is no separate form heading or permanent footer disclaimer. It follows streaming updates while the reader is near the bottom. Analysis stays outside the live status region; each clarification round preserves the previous summary in the in-memory conversation while resetting the active summary. Display messages are separate from the bounded request history and are never sent to the service. New operations, closing, account changes, and page lifecycle events discard the display conversation. Status queries clear the active summary.
