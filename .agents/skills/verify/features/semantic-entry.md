# Semantic chat entry

The `AI 記帳` button on a day card opens a dialog where the user types a sentence such as `午餐100`. The semantic service parses it and creates the expense, asks a follow-up question, or rejects it with a reason.

## Sub-features

- `semantic-create` creates an expense in one submit and shows `已新增`.
- `semantic-reject` shows `未新增` and the field reason without writing.
- `semantic-followup` asks a question (`role=status`) and accepts a reply in `補充資訊`.
- `semantic-image` switches to `圖片分析` for receipt images (receipt service).

## How to get to it (user POV)

- On a day card choose button `AI 記帳`.
- In the dialog, group `AI 記帳模式` has `文字記帳` and `圖片分析`.

## Driving it with Playwright (drive.mjs)

Preconditions:

- Baseline plus a `semantic` mock for `https://semantic.verify.invalid/semantic-entry/**` that checks `Authorization: Bearer <synthetic token>` and returns the contract shapes used in `e2e/semantic-entry.test.ts` (`status: 'created'`, `'rejected'` with `issues`).
- No journey file yet.

- **Open.** In the selected card click button `AI 記帳` (exact). Textbox `記帳內容` is visible.
- **Submit.** Fill `記帳內容` with `午餐100` and click button `送出記帳`. Text `已新增` appears; exactly one POST reached the semantic mock and no expense REST write happened.
- **Second view.** Close the dialog with button `Close`. The `2026-10-01` card shows the created note. Reload and it is still there (IndexedDB cache).
- **Reject.** With a 422 `rejected` mock, `未新增` and `金額：缺少必要資訊` appear.
- **Proof.** ARIA and screenshot after submit and after reload, plus `requests.json` showing the semantic POST.

## Gotchas

- `npm run test:e2e -- e2e/semantic-entry.test.ts` with the synthetic env from `.github/workflows/semantic-entry-check.yml` already covers these paths more deeply; use the journey for user-path evidence.
- The mock proves the browser contract only, not model output, Cloud Run, or the atomic write in the service.
- `圖片分析` posts to the receipt service; keep it mocked and never upload real receipts.
