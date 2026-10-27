# Expense entry and edit

From a day card the user opens `新增項目`, enters amount, scope, category, and note, and saves. The expense appears on that day. Choosing `Edit` on a row opens `編輯項目` for changes or deletion.

## Sub-features

- `entry-create` saves a new personal expense for the selected day.
- `entry-household` saves a household expense with payer and shares.
- `entry-edit` updates an existing expense from its row.
- `entry-delete` deletes an expense from the edit dialog.

## How to get to it (user POV)

- On a day card choose `今日第一筆記帳` (empty day) or `新增項目` (day with expenses).
- On an expense row choose button `Edit`.
- On `/summary`, expand a category and choose `Edit` on a row.

## Driving it with Playwright (drive.mjs)

Preconditions:

- Baseline plus a mock for `POST`/`PATCH`/`DELETE` on `rest/v1/expenses` that records the body and returns the saved row, and a categories mock with at least one category.
- No journey file yet. Add `journeys/expense-entry.mjs` based on `daily-carousel.mjs`.

- **Open.** In `section[data-date="2026-10-01"]` click button `今日第一筆記帳`. Dialog titled `新增項目` opens.
- **Fill.** Fill textbox `金額` with `120`, check radio `個人`, choose a category button, fill textbox `帳目內容` with `午餐便當`.
- **Save.** Click button `新增`. The dialog closes; the mocked write has `amount: 120`, `note: '午餐便當'`, `scope: 'personal'`.
- **Second view.** The `2026-10-01` card lists `午餐便當`. Reload and confirm it is still listed (mock reads must return the saved row).
- **Edit.** Click `Edit` on that row. Dialog `編輯項目` shows the saved values; change `帳目內容`, click `更新`, and assert the second write and the updated row.
- **Proof.** ARIA and screenshot after open, after save, after reload, and after update, plus `requests.json`.

## Gotchas

- `家庭` enables payer (`付款人`) and per-member shares; members come from the mocked `allowed_emails`.
- `已結清` is disabled unless scope is `家庭`.
- The calculator button next to `金額` is icon-only and has no accessible name while icons are blocked.
- Whether a category is required to save is not yet observed; record it here after the first run.
