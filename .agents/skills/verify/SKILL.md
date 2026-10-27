---
name: verify
description: Drive the JoPie expense-app web UI (SvelteKit preview on port 4173, mobile viewport) like a user, with Supabase, the receipt service, and the semantic service mocked, and capture ARIA, screenshot, and request evidence. Use to prove a UI behavior change, reproduce a UI bug, or before reporting a frontend change as working.
---

# Verify

Drive the built app in Chromium through Playwright with synthetic data only. The feature map in [features/README.md](features/README.md) is the recipe list; read it before driving.

Never sign in with Google, never use the real `.env` values, and never read or print `.env`. The real app holds personal expense data in production Supabase.

The scripted Playwright path here is the repo's own harness. For interactive, exploratory browsing follow AGENTS.md, which defaults browser automation to the Chrome plugin `browser-client` runtime, and keep the same mocks and no-sign-in rule.

## Launch

```sh
.agents/skills/verify/scripts/launch.sh [run-id]
```

- Refuses (exit 2) if anything already listens on 4173 or a previous state file exists. Do not drive an instance this run did not start.
- Exports synthetic `PUBLIC_*` values (`https://verify-stub.invalid`, `https://semantic.verify.invalid`, `https://receipt.verify.invalid`, `BASE_PATH=''`) that override `.env`, runs `npm run build`, then starts the equivalent of `npm run preview` as `node node_modules/vite/bin/vite.js preview --port 4173 --strictPort` so the recorded PID is the listener.
- Ready when it prints `READY pid=… url=http://localhost:4173 run=… evidence=…`, after `/` serves the `Loading JoPie` splash. Usable means the journey's first step passes (splash gone, no auth dialog).
- State lives in `$TMPDIR/expense-app-verify-4173.env` (PID, run id, evidence dir, mocked hosts).
- The build overwrites the git-ignored `build/` and `.svelte-kit/output` with the synthetic build. Rebuild before any other use of `build/`.
- Root base path only. A `/expense-app` subpath needs `BASE_PATH=/expense-app` and is not covered by these journeys.

## Doctor

```sh
.agents/skills/verify/scripts/doctor.sh
```

Read-only. Run it after launch and whenever anything looks off. It checks the PID is our `vite preview`, it alone owns port 4173, `/` serves JoPie, the build contains the synthetic hosts and no `*.supabase.co` host (it prints counts, never the hosts), and `test-results/verify` is git-ignored. Any `FAIL` line means do not drive: run cleanup and launch again.

## Drive

```sh
node .agents/skills/verify/scripts/drive.mjs <journey>
```

- Journeys are `scripts/journeys/<feature-id>.mjs`. Only `daily-carousel` exists. To add one, copy it: export `mocks` (handlers per mocked host returning the HTTP status, or `false` when unmatched) and `run({ page, state, hosts, step, evidence })`.
- The harness uses Playwright's bundled Chromium when installed, else installed Google Chrome (`channel: 'chrome'`, throwaway profile). Context: viewport 430x900, `timezoneId: 'Asia/Taipei'`, locale `zh-TW`, service workers blocked. Journeys fix the clock with `page.clock.setFixedTime`.
- Sign-in is a synthetic session in `localStorage` under `sb-verify-stub-auth-token`, plus a mocked `/auth/v1/user`. Supabase REST paths (`/rest/v1/<table>`) are mocked per journey.
- Network: only `localhost:4173` passes through. A request to a mocked host with no matching mock gets a 501. Every other host is aborted, including Google Fonts, `accounts.google.com/gsi/client`, and the Iconify APIs. WebSockets are closed. The run fails if anything else passed through or anything targeted `*.supabase.co`.
- Use the roles and names from the feature files: Traditional Chinese labels, `section[data-date="YYYY-MM-DD"]` for day cards.
- Exit 0 means every step passed; print the step lines in your report.

## Evidence

Each run writes `test-results/verify/<run-id>/` (git-ignored): `build.log`, `preview.log`, and `<journey>/` with `NN-<label>.aria.yml` and `NN-<label>.png` per step, `failure.*` on failure, `requests.json` (every non-local request with `mocked`, `unmocked-error`, or `blocked`), and `summary.json`.

- Capture the state after each user action, not only the end screen.
- Drive the real user path: roles, clicks, typing, swipes. No store setters or test-only routes.
- For writes, assert the mocked request (method, body) and a second view of the result, such as reloading or reopening the day.
- Report results as repository-verified only for what ran. These mocks cannot prove RLS, deployed Supabase or Cloud Run behavior, real OAuth, receipt or semantic model output, or transaction atomicity (AGENTS.md Validation). List those as external verification still needed.
- Icons and web fonts are blocked, so icon-only buttons render blank and have no accessible name. Do not judge visual polish from these screenshots.
- `npm run test:e2e` clears `test-results/` at start. Copy evidence elsewhere before running the e2e suite if you still need it.

## Cleanup

```sh
.agents/skills/verify/scripts/cleanup.sh
```

Kills only the PID in the state file, and only if it is still `vite.js preview`. Removes the state file and confirms port 4173 is free. It never deletes `test-results/verify/`. Run it after every run, including failed ones. If it reports the port is held by another PID, leave that process alone and report it.

## Helpers

| Script                      | Invocation                                          |
| --------------------------- | --------------------------------------------------- |
| `scripts/launch.sh`         | `.agents/skills/verify/scripts/launch.sh [run-id]`  |
| `scripts/doctor.sh`         | `.agents/skills/verify/scripts/doctor.sh`           |
| `scripts/drive.mjs`         | `node .agents/skills/verify/scripts/drive.mjs <id>` |
| `scripts/cleanup.sh`        | `.agents/skills/verify/scripts/cleanup.sh`          |
| `scripts/common.sh`         | Sourced by the shell helpers; synthetic env.        |
| `scripts/journeys/<id>.mjs` | Loaded by `drive.mjs`.                              |

Typical run from the repo root:

```sh
S=.agents/skills/verify/scripts
$S/launch.sh && $S/doctor.sh && node $S/drive.mjs daily-carousel; $S/cleanup.sh
```
