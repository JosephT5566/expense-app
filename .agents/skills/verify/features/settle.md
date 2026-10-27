# Settlement

The `/settle` route (`支出結清`) lists unsettled household expenses in a date range, suggests transfers between members, and marks selected expenses settled.

## Sub-features

- `settle-list` lists unsettled expenses for the range.
- `settle-suggest` shows transfers under `建議結清` for the selected rows.
- `settle-mark` marks selected rows settled with `設為結清`.
- `settle-undo` restores the last settled batch with the icon-only restore button.

## How to get to it (user POV)

- Choose link `更多功能`, then link `分帳`, or open `/settle`.
- The range picker is titled `選擇計算範圍`.

## Driving it with Playwright (drive.mjs)

Preconditions:

- Baseline with two allowed emails and an expenses mock returning unsettled `household` rows with `shares_json` for both, plus a mock for the bulk `is_settled` update that records ids.
- No journey file yet.

- **Open.** Click `更多功能`, then `分帳`. Heading `支出結清` is visible and rows are listed, or `此區間沒有待結清項目`.
- **Select.** Check `Select All`. `建議結清` lists a transfer, or `已平衡，無需轉帳`.
- **Mark.** Click button `設為結清`. The mocked update sets `is_settled: true` for the selected ids, and the rows leave the list.
- **Proof.** ARIA and screenshot after select and after mark, plus the update request in `requests.json`.

## Gotchas

- `建議結清` shows `尚未選擇項目` until a row is selected.
- The restore button is icon-only and unnamed while icons are blocked; locate it as the button after `設為結清`.
- Mocks cannot prove RLS or that the bulk update is atomic; report those as external verification.
