# Semantic entry v3: text, images and drafts

The `AI 記帳` button on a day card opens one conversation. Users can type a single expense or attach receipt images, review drafts, continue with text, and commit all visible complete drafts. There is no text/image mode switch.

## User paths

- **Text.** Fill `記帳內容`, submit, and verify `已新增`, a clarification question, or `未新增`. Pure text retains single-expense clarification; replies use `補充資訊`.
- **Attach.** Use `附加圖片` or the camera action. Preview thumbnails can be removed before submit. JPEG/PNG/WebP are accepted; HEIC/HEIF are converted locally. Limits are four images, 10 MiB each, 20 MiB total after conversion. Image-only submission is supported.
- **Analyze.** The client requests upload URLs, PUTs bytes to storage, then sends v3 `analyze` with paths and optional text. One complete expense is written directly. Multiple or incomplete image results appear as `草稿` / `尚未記帳` with completeness and field issues.
- **Continue.** With drafts present, submit correction text. The v3 `revise` request sends current drafts; results update the inline draft block without expense writes.
- **Edit.** `進入編輯` opens draft cards. Users can edit fields using the shared editor, select and merge entries, ungroup, hide and restore entries. Changes remain local; hidden entries are excluded from commit. Follow accessible names in `DraftEditDialog.svelte` and the existing E2E specs.
- **Commit.** `全部記帳（N 筆）` is enabled only when all visible drafts are complete. Verify a v3 `commit` request, then a created summary and store/cache updates. Rejection preserves drafts and shows field errors; an uncertain result locks editing and preserves the exact commit UUID/payload for retry.
- **Recover.** Reload retains only account-scoped pending metadata (requestId, submit time, kind, optional 12-code-point snippet or counts). The title-bar badge (`待確認 n 筆`, or `待確認` when only expired items remain) opens the `待確認` popover tray; rows expand in place with `查詢結果`, `重試同一請求` (only while the exact payload is in memory) and `刪除這筆待確認`. Delete re-queries first and asks `確定刪除這筆待確認？` on not_found. Expired rows show `已過期` and `關閉已過期項目`. A fourth active submission shows the `已有3筆待確認，暫時無法建立新對話` status toast. Status lookup returns completed expenses or not_found; it cannot restore discarded drafts or request text.

## Mocked verification

Use `npm run test:e2e -- e2e/semantic-entry.test.ts e2e/daily-carousel.test.ts`, then `BASE_PATH=/expense-app E2E_BASE_PATH=/expense-app npm run test:e2e -- e2e/semantic-entry.test.ts` with synthetic public configuration. Do not supply a legacy receipt endpoint. `e2e/semantic-entry.test.ts` is the executable reference for mock payloads and assertions; no drive.mjs journey is registered yet.

For a browser journey, install `page.route` mocks before navigation for all Supabase requests, the semantic origin (including `/semantic-entry/uploads` and status), and signed storage URLs; abort any other external traffic. Use only synthetic image buffers and accounts. Semantic POST/GET carry the synthetic Supabase bearer and negotiate `semantic-version=3`; storage PUT carries only returned requiredHeaders and no Authorization. Responses must match the parsers in `packages/semantic-entry-contract/src/index.ts`.

Capture ARIA/screenshots after attachments, returned drafts, local editing, revise and commit, plus request evidence. Assert no direct expense REST write, no write on revise, new UUID for a new commit, and unchanged UUID/payload for uncertain retry. After first creation, close/reload and verify the cached expense; replay/status recovery refreshes current rows rather than restoring stale snapshots.

Mocks establish browser behavior and wire compatibility only. They do not verify Gemini extraction quality, deployed RLS, GCS IAM/CORS/lifecycle, Cloud Run buffering or production RPC transactions. Never upload real receipts or call deployed services in this workflow.
