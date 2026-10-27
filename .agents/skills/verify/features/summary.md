# Monthly summary

The `/summary` route shows a pie chart and a per-category list for a month. Each category expands to its expenses, which can be edited.

## Sub-features

- `summary-month` shows the current month's totals by category.
- `summary-pick` switches month.
- `summary-expand` expands a category to list its expenses.
- `summary-empty` shows `本月無資料` for a month without expenses.

## How to get to it (user POV)

- Choose link `統計` in the bottom navigation, or open `/summary`.
- The month control is a button showing `2026/10` on desktop user agents, opening dialog `選擇月份` with a month input and button `完成`. On mobile user agents it is an inline month input.

## Driving it with Playwright (drive.mjs)

Preconditions:

- Baseline plus an expenses mock with rows in at least two categories for October 2026, and a categories mock whose ids match.
- No journey file yet.

- **Open.** Click link `統計`. The URL is `/summary`; the category list shows each category label and amount.
- **Expand.** Click a category trigger. Its expenses are listed with button `Edit`.
- **Pick month.** Click button `2026/10`, set the month input in dialog `選擇月份` to `2026-09`, click `完成`. The list updates for September or shows `本月無資料`.
- **Proof.** ARIA and screenshot after open, expand, and month change, plus the expense query bounds in `requests.json`.

## Gotchas

- The harness keeps a desktop user agent, so expect `is-mobile` to report false at 430px and the dialog month picker to appear (not yet observed).
- Expenses with no category group under `未分類`.
