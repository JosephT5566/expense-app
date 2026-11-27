# JoPie expense app

JoPie is a personal and household expense tracker built for Joseph and Pieda. It supports expense entry and editing, monthly category summaries, shared-expense settlement, scheduled and recurring expenses, and receipt import with AI-assisted review. The interface is primarily in Traditional Chinese.

The app uses Svelte 5, SvelteKit, TypeScript, and Supabase. It builds as a static site for GitHub Pages and includes PWA configuration through the Vite PWA plugin.

Summary 圓餅圖下方提供預設收合的近六個月開銷折線圖，透過全寬按鈕（左側標題「近 6 個月開銷」、右側向下箭頭）展開後才載入圖表及月總和；展開時箭頭旋轉 180°，再按一次收合並卸載圖表與摘要。點選月份只選取，按「切換」才更新檢視月份。折線圖隨個人／共同分頁切換，圓餅圖與分類列表維持逐筆計算。背景重查時保留既有圖表與已選月份，只有帳號或六個月視窗改變才清空；收合會卸載圖表與狀態訊息，但保留已載入資料；再展開時直接顯示圖表，資料過期則在背景重查，已選月份會重設。折線圖只用兩個主題都有定義的主題變數。 資料與快取責任見 [架構文件](docs/architecture.md#summary-monthly-trend)。

## Development

Use Node.js 22.12 or later within Node 22 to match CI, then install dependencies:

```sh
npm ci
```

Create a local `.env` with these values from your existing Supabase project and semantic-entry service. Service deployment is an operator action; see [deployment](docs/semantic-entry-deployment.md).

```dotenv
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
PUBLIC_EMAIL_NAME_MAPPING={"member@example.com":{"name":"Member","color":"#808080"}}
# Enable AI entry for text and receipt images
PUBLIC_SEMANTIC_ENTRY_URL=https://your-semantic-service.run.app
BASE_PATH=
```

`PUBLIC_EMAIL_NAME_MAPPING` is a JSON object keyed by email for `allowedUserInfo` in `src/lib/stores/appSetting.store.ts`. The separate `getUserInfo` helper currently expects an array instead; verify its callers before changing that contract. `PUBLIC_*` values are included in client builds; use a Supabase publishable key, never a service-role key.

Enable Google OAuth in Supabase and allow the app's origin and base path as a redirect URL. The app expects the database objects described in [Database and service contracts](docs/database.md).

```sh
npm run dev
```

## Build and validation

| Command                      | Purpose                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run icons:subset`       | Regenerate the committed offline Iconify subset; prebuild checks drift and source coverage |
| `npm run check`              | Sync SvelteKit and check Svelte/TypeScript                                                 |
| `npm run lint`               | Check Prettier formatting and run ESLint                                                   |
| `npm run format`             | Format the repository in place                                                             |
| `npm run build`              | Build the static site into `build/`                                                        |
| `npm run preview`            | Preview the production build                                                               |
| `npm run test:e2e:base-path` | Run isolated base-path navigation tests on preview port 4174                               |
| `npm run test:e2e`           | Run Playwright, which builds and starts the preview server                                 |
| `npm run test:unit`          | Run Vitest unit tests (`src/**/*.test.ts`, Node, mocked fetchers and caches)               |

The E2E suite includes daily carousel tests with mocked Supabase authentication and responses, covering date jumps, repeated swipes, month/year boundaries, bounded card rendering, DOM reuse within and across buffer shifts, date jumps during animation, empty months, and retrying failed loads. The original scaffold test still checks for a visible home-page `h1`. These tests do not verify live authentication or settlement workflows.

The Vitest unit tests include route-to-tab matching and the shared navigation items (`src/lib/components/ui/nav-items.test.ts`), plus monthly loading into the expense store (`src/lib/data/month-loader.test.ts`, `src/lib/data/month-loader.race.test.ts`) and summary grouping (`src/lib/utils/summary.test.ts`): full-month loads despite partial rows, loaded-month tracking, stale-cache revalidation merging into the store, local edits and deletes made while a load is in flight, cache consistency, sign-out during a load, months larger than one page, and scheduled approval in a non-current month. They mock Supabase, IndexedDB (an in-memory `idb-keyval` fake in the race tests), and the scheduled fetchers, and run in the `frontend` job of `semantic-entry-check.yml`. `src/lib/utils/category-colors.test.ts` covers the summary’s 12-color palette, deterministic `(sort_order ?? 0, id)` assignment, response-order independence, unique registered colors up to palette capacity, overflow cycling, reserved uncategorized/empty colors, unknown-id hashing, category registry changes, and gray for non-positive amounts. The custom palette varies hue and lightness across blue, orange/brown, green, coral, rose and violet. Tests include both reserved colors: every pair differs by at least 20° circular hue or 12 HSL lightness percentage points; the 70°–190° yellow-green/cyan band has at most three colors, whose pairs need at least 40° hue or 12 lightness points. Every active/reserved color has at least 3:1 sRGB contrast against white and the Moss Night card/page backgrounds (`#101b20`/`#0b1215`). Chromatic saturation separates them from inactive gray. These thresholds do not establish color-vision accessibility or recognition of 4px dots. `src/lib/utils/summary-chart-label.test.ts` checks accessible totals and category percentages. `e2e/summary-month.test.ts` checks summary month switching, hidden legends, chart/dot color matching, zero amounts, nine simultaneous distinct positive category colors, accessible totals, and color stability across months, scopes, amount ordering, and page navigation with mocked Supabase. Its ten-category fixture deliberately returns rows out of `sort_order` order.

`e2e/summary-month.test.ts` and `e2e/summary-colors.fixture.ts` read `process.env.PUBLIC_SUPABASE_URL` only for the mock host; they do not read `.env` files. For local runs, export synthetic build-time `PUBLIC_*` values as in `.github/workflows/semantic-entry-check.yml` before running Playwright:

```sh
export PUBLIC_SUPABASE_URL=https://synthetic.supabase.co
export PUBLIC_SUPABASE_PUBLISHABLE_KEY=synthetic-publishable-key
export PUBLIC_EMAIL_NAME_MAPPING='{}'
export PUBLIC_SEMANTIC_ENTRY_URL=https://semantic.example.test
export BASE_PATH=''
npm run test:e2e -- e2e/summary-month.test.ts
```

All remote requests are mocked or blocked; these values do not provide live authentication. The fixture rejects non-synthetic Supabase hosts. These specs do not load environment files themselves; the build toolchain normally supports environment files separately.

For a targeted carousel check, run `npm run test:e2e -- e2e/daily-carousel.test.ts`. Playwright needs its browser installed (`npx playwright install chromium`) and the build-time environment above. The suite builds and starts a preview server on port 4173. Keep `BASE_PATH` empty for the existing specs, which navigate to root paths; use the separate base-path suite for deployment subpaths.

Run `npm run test:e2e:base-path` with the synthetic `PUBLIC_*` values above to check mobile and desktop navigation under `/expense-app`. The independent `playwright.base-path.config.ts` builds with `BASE_PATH=/expense-app` and starts preview at `http://localhost:4174/expense-app/` with `--strictPort` and no server reuse. Its `e2e-base-path/` specs block service workers and WebSockets, mock Supabase, and abort other remote requests. They check route-id-based active link classes and `aria-current`, direct summary entry, the base root with and without a trailing slash, document preservation across navigation, and resetting the main scroll container after tab navigation at both 390px and 1280px widths. The four tabs are 新增, AI 記帳, 統計, and 更多功能. The nav is located by role and the accessible name「主要導覽」. Tests check `/ai-entry` highlighting with `aria-current="page"`, visible mobile and desktop labels, mobile touch targets of at least 44×44px, a 64px floating capsule with 22px icons and 14px side insets, zero Iconify host requests, and composer gaps of at most 12px at both zero inset and a test-CSS simulated 34px safe area. Long conversation content scrolls inside the message list. Direct settlement, search, and scheduled entry highlight 更多功能 with `aria-current="true"`; the setting page itself uses `aria-current="page"`. The default `e2e/` suite and port 4173 configuration are unchanged. The `frontend` job of `semantic-entry-check.yml` runs this suite last, after the semantic-entry base-path tests. After `npm run test:e2e:base-path`, `build/` contains the `/expense-app` build; rebuild with your normal base-path setting before using `npm run preview`.

For documentation-only changes, run `npx prettier --check <changed Markdown files>` and `git diff --check`, then verify local links and source references. Format only those files with `npx prettier --write <changed Markdown files>` if needed. Application builds and E2E runs are unnecessary for documentation-only changes.

For deployment under a repository subpath, set `BASE_PATH` to `/expense-app` (or the actual repository name) when building. Development uses an empty base path. GitHub Actions builds pull requests to `master` and deploys pushes to `master` or manual workflow runs to GitHub Pages, using environment values configured in the workflows.

The original Pages/build workflows remain. `semantic-entry-check.yml` adds backend unit/type checks, synthetic fixture evaluation, container smoke tests, disposable Supabase integration, frontend checks and Vitest unit tests, explicitly scoped lint, and root/subpath Playwright tests including base-path navigation. It uses synthetic frontend configuration and no paid model key. Whole-repository `npm run lint` has existing Prettier failures; scoped CI lint does not establish whole-repository cleanliness. Python/browser wire parity is checked separately; it is not a generated-schema drift check. New hosted CI executions remain unverified until GitHub runs them.

`semantic-entry-deploy.yml` is a separate manual, `master`-only Cloud Run release workflow. It verifies the backend/container before using OIDC credentials, pushes to Artifact Registry, deploys an immutable digest, and checks `/health`. It does not configure IAM, apply SQL, deploy Pages, or run paid evaluations. See [deployment setup](docs/semantic-entry-deployment.md#github-actions-release).

## Agent workflow

[AGENTS.md](AGENTS.md) routes tasks to the existing context documents and defines product boundaries, verification by change type, and evidence reporting. The workflow is: read relevant context, confirm it against source, make a focused change, run applicable checks, update affected documentation, and hand off a reviewable diff with results and remaining limitations.

Documentation ownership stays with the existing files: setup, commands, and CI here; source responsibilities and data flow in [Architecture](docs/architecture.md); external/frontend contracts in [Database and service contracts](docs/database.md). These serve as current project context without a separate duplicate memory file. Reusable documentation maintenance lives in the [expense app guide skill](.agents/skills/expense-app-guide/SKILL.md); root instructions hold shared rules.

Report findings as `repository-verified`, `operator-reported`, or `unverified` according to the evidence available. Client types, comments, and mocked responses do not prove deployed Supabase policies or receipt-service behavior. Keep historical check outputs in task artifacts and distinguish them from checks run for the current change.

Issue-first development (raw issue, enhancement, `ai-ready` approval, implementation PR, independent review) is described in [Agent workflow](docs/agent-workflow.md). This is a local coding-agent workflow. No issue-to-PR agent automation is configured. The synthetic semantic-entry harness below evaluates local rules separately from live model quality. Historical household splits use a bounded read-only tool loop in text and receipt extraction, with backend matching and non-equal confirmation through existing options; see [behavior and limits](docs/database.md#historical-household-splits). Ordinary text streaming keeps its current behavior; history-triggered text uses non-streaming extraction within the same SSE result contract.

## Project documentation

- [Architecture](docs/architecture.md): routes, module responsibilities, and data flow.
- [Database and service contracts](docs/database.md): frontend contracts and inherited Supabase notes.
- [Agent instructions](AGENTS.md): repository guidance and documentation maintenance rule.
- [Agent workflow](docs/agent-workflow.md): issue-first stages and the prompt for each stage.
- [Expense app guide skill](.agents/skills/expense-app-guide/SKILL.md): explain the app and update affected documentation.

## Semantic expense entry

The second navigation tab「AI 記帳」in BottomNav or SideNav navigates to the standalone `/ai-entry` chat page. Mobile bottom navigation shows only icons with accessible link names; desktop side navigation keeps visible labels. The AI 記帳 tab is selected on `/ai-entry`. It accepts text and receipt attachments in one conversation. Text and image analysis use the Python/LangGraph service; complete single results are written automatically, while multiple or incomplete results become editable drafts. The page streams analysis, asks clarification questions, and supports draft revision and explicit batch confirmation. Leave through the navigation tabs. 新對話 retains the submitted conversation in local history before clearing the current conversation and is disabled during processing or image conversion.

`conversation.svelte.ts` retains the conversation, drafts, request state and controllers in module memory across in-app navigation. Responses continue updating that state while the page is unmounted. Receipt blob previews and local files are runtime-only. Account changes or logout abort and clear prior-account work even while the page is unmounted. Account-scoped localStorage preserves up to 20 conversations, including clarification history, current question, drafts and uploaded GCS paths, for 24 hours from each conversation’s first submission. Load/save prunes expired entries and drops the oldest first submissions above the cap. Legacy single-conversation values migrate on read. Reloading loses the connection, then restores the most recently updated in-progress conversation, or the latest remaining conversation. 對話紀錄 opens a history panel on the same route, listing summaries, Taiwan times and status with icons, newest first. Selecting a row saves the current thread and loads that conversation. If changed, unexpired content cannot be saved, selection and 新對話 retain the current thread and show a storage error. Completed selections and rows that expire while the panel is open are read-only and never resend automatically. Switching is disabled during analysis, image conversion/uploads and status lookup. The chat has an accessible AI 記帳 region name without a visible title. Requests that may have written are queried before continuing: completed results are read-only; not-found results offer an explicit same-payload resend. Automatic reload recovery confirms completion through the backend status GET. Blob previews and local files are never stored; restored receipts obtain runtime-only HTTPS URLs through `POST /semantic-entry/uploads/urls` and render with `<img>`. Requests batch up to four unique paths and retry a missing batch per path; image load failure re-signs once, then shows the existing placeholder. Signed URLs never enter localStorage or IndexedDB. Server `conversation_expired` responses make the thread read-only with an assistant explanation and no automatic resend; 新對話 starts again. See [semantic service contracts](docs/database.md#semantic-entry-service). Switching accounts or logging out removes the previous account’s saved conversation list. The「待確認」header badge opens a tray for status lookup, retained-payload retry, or deletion after a fresh lookup. At most three unexpired pending items are allowed. See [semantic entry architecture](docs/architecture.md#semantic-entry) for recovery, expiry, storage and timeout behavior. Without `PUBLIC_SEMANTIC_ENTRY_URL`, submission reports that the service is not configured.

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

Fixture mode uses 40 synthetic cases, five in each of eight groups, repeated three times. It does not read the model key, contact a provider, or persist expenses. Its results measure the normalizer/scorer against authored raw outputs, not model extraction quality. The 40 cases in `services/semantic-entry/evals/cases.json` are normalizer fixtures and cannot be used in live mode. Live mode instead loads 27 natural-language cases from `services/semantic-entry/evals/model-cases.json`, including multi-round corrections, withdrawn dates, category ambiguity, and member matching. It uses the runtime conversation serialization. Fixture refusals require exact issues; model refusals require the listed semantic issues and allow additional missing-field issues. Valid model cases check exact structured fields and required description substrings. These substring checks do not establish semantic note quality. The manifest records the selected suite, file hash, and scoring method. Unknown usage/pricing remains null. Authorized live evaluation uses `GEMINI_API_KEY` and optional `SEMANTIC_MODEL` (default `gemini-3.5-flash-lite`). For a separately authorized live evaluation, `uv run --directory services/semantic-entry --locked python -m semantic_entry.evaluation --mode live --out /tmp/jopie-semantic-live-eval` calls only the provider, caps attempts at 120, and never imports the persistence adapter. Optional cost assumptions use `SEMANTIC_INPUT_USD_PER_MILLION`, `SEMANTIC_OUTPUT_USD_PER_MILLION`, `SEMANTIC_PRICING_SOURCE`, and `SEMANTIC_PRICING_AS_OF`; estimates are not bills.

Member display names have one deployed source: GitHub `vars.PUBLIC_EMAIL_NAME_MAPPING` (`{email:{name,color}}`). The semantic release-validation helper derives `{email:name}` into runtime `SEMANTIC_MEMBER_NAMES`; the service itself does not read `PUBLIC_*`. Local backend tests may set `SEMANTIC_MEMBER_NAMES` directly. After merging this change, an operator must dispatch a new semantic deployment from `master`, then remove the obsolete `vars.SEMANTIC_MEMBER_NAMES` after success. No fallback to that variable remains.

AI clarification offers server-generated radio options with explicit confirmation for members, categories and integer split candidates. Free-text questions retain 「補充資訊」. Text and image replies keep the same UUID/date baseline and at most three answers. AI drafts support custom per-member whole-TWD amounts, with an exact-sum check before saving. The new custom-share SQL migration must be reviewed/applied by the operator before enabling custom writes in production.

Disposable SQL setup, backend environment values, and release/IAM instructions are in [deployment setup](docs/semantic-entry-deployment.md). The public baseline and existing semantic migration history were adopted on 2026-10-13, and a trigger type fix was applied. See [database adoption evidence](docs/evidence/semantic-entry/2026-10-13-database-baseline.md) for scope and remaining service/schema compatibility gaps. The checked-in test schema is synthetic and must never be applied to production.

For semantic browser tests, use `PUBLIC_SEMANTIC_ENTRY_URL=https://semantic.example.test npm run test:e2e -- e2e/semantic-entry.test.ts`. To verify the Pages path, also set `BASE_PATH=/expense-app E2E_BASE_PATH=/expense-app`. The carousel specs still expect root paths.

See the [evidence index](docs/evidence/semantic-entry/README.md), [design](docs/superpowers/specs/2026-10-11-semantic-expense-entry-design.md), and [implementation plan](docs/superpowers/plans/2026-10-11-semantic-expense-entry.md). Local implementation is available; service/schema type alignment, paid model quality, and hosted acceptance remain outstanding.

### Database migration workflow

`supabase-migrations.yml` validates the complete captured schema chain on PRs and supports master-only manual production migration with dry-run enabled by default. It requires the reviewed baseline to be already adopted and uses an isolated CLI workspace. Configure the environment and secrets described in [production migrations](docs/semantic-entry-deployment.md#production-migrations); no hosted workflow run is claimed.

```sh
# Disposable localhost full schema-chain assertions, no production access.
services/semantic-entry/scripts/baseline-db-test.sh
```

The baseline script waits for the container's TCP listener, avoiding the temporary socket-only server used during PostgreSQL initialization. If readiness fails after 30 attempts, it prints the container logs and stops before creating the test database or applying SQL. It removes only the disposable container it successfully created.
