# Daily carousel

The home route `/` shows one card per day around the selected date. The user swipes between days, jumps to any past date with the date input, retries a month that failed to load, and returns with `Today`.

## Sub-features

- `carousel-open` shows today's card for a signed-in user.
- `carousel-swipe` moves one day per swipe and shows that day's expenses.
- `carousel-jump` jumps to a date in another month and loads it.
- `carousel-retry` shows `載入支出失敗，請稍後再試。` for a failed month and `重試` reloads it.
- `carousel-today` returns to today and hides the `Today` button.

## How to get to it (user POV)

- Open `/` or choose link `新增` in the bottom navigation.
- Swipe a card left or right.
- Type in textbox `Expense date`.
- Choose button `Today` (shown only away from today).

## Driving it with Playwright (drive.mjs)

Preconditions:

- Baseline. The expenses mock returns `September dinner` on 2026-09-30 for the query whose `ts=gte.` bound contains `2026-08-31`, fails the first query containing `2026-07-31` (August) with 500, and returns `[]` otherwise.

Run `node .agents/skills/verify/scripts/drive.mjs daily-carousel`.

- **Open.** `goto /`. Status `Loading JoPie` disappears, no dialog, `Expense date` is `2026-10-01`, and the `2026-10-01` card shows button `今日第一筆記帳`.
- **Swipe.** Drag the selected card from x=80 to x=350. `Expense date` becomes `2026-09-30` and that card contains `September dinner`.
- **Jump.** Fill `Expense date` with `2026-08-15`. The `2026-08-15` card contains `載入支出失敗`.
- **Retry.** Click button `重試` in that card. It contains `No Records`, after exactly two August queries.
- **Today.** Click button `Today` (exact). `Expense date` is `2026-10-01` and `Today` is gone.
- **Proof.** `01-home-today` to `05-back-to-today` `.aria.yml` and `.png`, `requests.json`, `summary.json`.

## Gotchas

- Adjacent cards are rendered too. Scope assertions to `section[data-date=…]`, not page text.
- The window shifts only after the swipe settles. Assert the `Expense date` value, not card positions.
- Month loads use the Taipei month start in UTC (`2026-07-31T16:00Z` for August). Match mocks on that bound.
- `e2e/daily-carousel.test.ts` covers window bounds and DOM reuse in more depth; this journey proves the user path.
