# Contract v3 與批次 RPC 短說明

本說明對應目前的 TypeScript／Python v3 驗證器、雜湊函式及批次 SQL；
描述程式碼契約，不代表已部署或已驗證正式環境。

## v3 request

所有 request 都需要 UUID `requestId` 與 `action`，可附 `referenceDate`。
`referenceDate` 是年份至少 0100 的有效 `YYYY-MM-DD`。
`action` 僅接受 `analyze`、`revise`、`commit`：

- `analyze`：純文字需要 `text`；圖片模式需要 `images`，可附 `text`（可空白）。
- `revise`：需要 `text` 與 `drafts`。
- `commit`：需要 `drafts`，不接受 `text`、`history` 或 `images`。
- 純文字 analyze／revise 可附 `history`，最多三組 `{question, answer}`。

文字會 trim 並做 NFC 正規化；text 最多 500 字元，history 問答上限為 300／500。
`images` 是 1–4 個路徑字串，每個最多 1024 字元，不接受含 `..` 的路徑；
路徑須已符合 trim／NFC 結果。request 不接受圖片 generation 欄位。
`drafts` 是 1–20 筆，包含 `draftId` 與八個欄位：
`note`、`amount`、`currency`、`date`、`categoryId`、`scope`、`payerEmail`、`splitMemberEmails`。
每欄包含 `value/state/confidence/source`，date 另含 `defaulted`；
state 區分 recognized、unrecognized、missing、explicit_null。
草稿可附 `mergedFrom`、`originalAmount`。
用戶端回傳草稿可省略 `status`、`issues`、`updated`；有帶會先驗證再丟棄。

## v3 response 與 SSE

response 都包含 `status`、`requestId`。
`created` 回傳 1–20 筆 `expenses`、`replayed`、可為 null 的 `metadata`；
`drafts` 回傳草稿、`reason: multiple | incomplete` 與 metadata。
`needs_input` 包含 question／issues；`rejected` 包含 issues，可附逐草稿 draftIssues。
狀態查詢為 `completed`（expenses、replayed:true）或 `not_found`。
SSE `result` 使用上述 v3 response；其餘事件為 `analysis_delta`、
`persisting`、`error`。analysis_delta 包含 requestId／非負整數 seq／1–200 字元 text；
persisting 包含 status／requestId；error 包含 `{error:{code,uncertain}}`。

## v4 input_hash

有 images 或 drafts 時，input_hash_v4 使用 SHA-256：
內容為 `v4\n` 加上固定欄位順序的緊湊 JSON，數字採 ECMAScript 表示法。
依序涵蓋 action、text（預設空字串）、history（預設 []）、referenceDate（預設 null）、
images（依序為 path／服務讀取的 generation）、drafts（預設 []）。
草稿包含 draftId、可選 mergedFrom／originalAmount，以及八欄的全部欄位資料；
status／issues／updated 已被丟棄，不參與雜湊；requestId 也不參與。
沒有 images／drafts 時沿用既有 input_hash 的 v1／v2／v3 分支。
此函式要求呼叫端明確使用；本說明不宣稱 graph 已切換至 v3 流程。

## 批次 RPC

簽章：`public.create_semantic_expenses(p_request_id uuid, p_input_hash text, p_expenses jsonb) returns jsonb`。
成功回傳 `{expenses, replayed}`；一批 1–20 筆，依輸入順序寫入並保存快照。
RPC 在同一交易中操作 ledger、expenses 與 trigger shares，失敗整批回滾。
金額為正整數且不超過 9999999999；shares 為非負整數且總和等於 amount。
household 只接受平分，餘數給 `min(key collate "C")`。

- PT401：Authentication required；PT403：Membership required。
- PT400：Invalid request identity（request_id 缺少，或 hash 非 64 位小寫十六進位）。
- PT409：Request text conflict（hash 不同，或該 request_id 存的是單筆 RPC 快照）。
- PT422：Invalid expense batch（非陣列或筆數超出範圍），不帶 index。
- 逐筆驗證的 PT422 帶 details 字串 `{"index": N}`，N 從 0 起算；
  PostgREST 的 details 是 JSON 字串，需要再解析一次，才能取得 index。
- 格式錯誤的 ts／category_id 與超額 amount 分別回報
  Invalid expense date／Invalid category／Invalid amount。

同一使用者的 request_id 與 hash 相符且已有批次快照時，
直接回原 expenses 並帶 `replayed:true`，不會重新驗證 p_expenses。
已知限制：單筆 RPC 對格式錯誤的 ts、category_id 或超大金額會拋出原生錯誤。

完整文件於 #49 的 PR3 補上。

## 上傳端點

`POST /semantic-entry/uploads` 使用同一個 Supabase Bearer，接受 `{files:[{contentType,size}]}`。
每次 1–4 張，僅 JPEG／PNG／WebP；每張正整數 bytes，最多 10 MiB，合計最多 20 MiB。
回應 `{uploads:[{path,url,expiresAt,requiredHeaders}]}` 與輸入順序相同。
用戶端只以 requiredHeaders 對 HTTPS signed URL PUT 圖片，不附 Authorization；
後續 v3 analyze 的 images 僅送 path，不送 generation。上傳失敗不代表有支出寫入。
