# JoPie verification map

The maintained source for verifying JoPie's user-facing behavior. Read this index, then use the matching feature file as the recipe. Launch, doctor, drive, and cleanup commands are in [../SKILL.md](../SKILL.md).

## Baseline preconditions

- `launch.sh` built the app with synthetic env and `doctor.sh` reports no `FAIL`.
- Clock fixed at `2026-10-01T12:00:00+08:00`, timezone `Asia/Taipei`, viewport 430x900, so the bottom navigation (`新增`, `統計`, `更多功能`) is visible.
- Signed in by the synthetic `localStorage` session for a user whose email is in the mocked `app_settings.allowed_emails`. Without it, or with `/auth/v1/user` unmocked, the auth dialog appears instead of the app.
- Every journey mocks `auth/v1/user`, `rest/v1/app_settings`, `rest/v1/categories`, `rest/v1/scheduled_expenses`, and the `rest/v1/expenses` reads it needs.

## Driving conventions

- Prefer ARIA roles and accessible names; the UI labels are Traditional Chinese and must be matched exactly.
- Day cards are `section[data-date="YYYY-MM-DD"]`. The selected day is the value of textbox `Expense date`.
- Wait for the `Loading JoPie` status to disappear before acting.
- A journey that needs data the mocks do not provide fails and the reason goes in that feature's `Gotchas`. Do not weaken the journey.

## Proof and skip reporting

- Capture ARIA and a screenshot after each user action, plus `requests.json`.
- A write is proven by the mocked request (method and body) and a second view, such as a reload or reopening the day.
- Name the journey and entry point with every result. A feature without a journey file is unverified, not passed.

## Feature entry contract

Each feature file has an H1, a one-paragraph description, then `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright (drive.mjs)`, and `Gotchas`.

## Features

| Feature                                      | Journey                   | Status                                  |
| -------------------------------------------- | ------------------------- | --------------------------------------- |
| [Daily carousel](./daily-carousel.md)        | `journeys/daily-carousel` | Proven 2026-10-27 (run 20261027-proof2) |
| [Expense entry and edit](./expense-entry.md) | none yet                  | Recipe only                             |
| [Semantic chat entry](./semantic-entry.md)   | none yet                  | Recipe only; e2e spec covers it         |
| [Monthly summary](./summary.md)              | none yet                  | Recipe only                             |
| [Settlement](./settle.md)                    | none yet                  | Recipe only                             |
