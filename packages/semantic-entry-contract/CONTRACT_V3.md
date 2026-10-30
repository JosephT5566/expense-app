# Contract v3 與批次 RPC

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
`graph_v3.py` 的圖片／草稿分支使用此函式；純文字 analyze 委派既有 graph。

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

## HTTP 協商、期限與 requestId

`POST /semantic-entry` 使用 `Authorization: Bearer <Supabase session access token>` 與 JSON body。
以 `Accept: text/event-stream; semantic-version=3` 取得 SSE，或
`Accept: application/json; semantic-version=3` 取得 JSON。未協商 v3 的請求維持舊契約。
服務會驗證身分與 allowlist；不接受用戶端提供 identity、hash 或額外未定義欄位。
v3 JSON 拒絕重複 key、非有限數字及不合法 Unicode；body 上限 65,536 bytes（64 KiB），
超過回 HTTP 400 `body_too_large`，契約不合法回 400 `invalid_request`。
`referenceDate` 不得晚於服務端台灣當日；純文字對話保留第一次送出的日期基準。

Cloud Run 設定 90s／1Gi；圖片 analyze 的服務 deadline 目前是 85s（必須小於 90s），
瀏覽器 transport 為 92s。純文字 analyze、revise、commit 目前沿用 30s 服務 deadline，
瀏覽器 transport 為 32s。90s 並非所有操作的應用層期限。

`requestId`、`draftId` 與 `mergedFrom` 項目均須符合 UUID 的 8-4-4-4-12 十六進位格式。
新 analyze／revise／commit 使用新的 UUID；同一不確定寫入的重試須保留原 UUID 與完整 payload。
純文字補答保留對話 UUID，但答案會改變 hash；已完成 UUID 改用不同 hash 會衝突。
同一使用者已完成且 hash 相同的請求回放原快照，不會再次新增。
圖片 hash 綁定服務讀取的 generation，不能由用戶端指定。

`GET /semantic-entry/:requestId` 使用同一 Bearer，並以
`Accept: application/json; semantic-version=3` 協商陣列回應。
完成時為 `{status:"completed",requestId,expenses,replayed:true}`；
查無快照為 `{status:"not_found",requestId}`，不代表已取消或未寫入。
草稿與續談不是已完成 ledger 紀錄；status 不回傳草稿。查詢不呼叫模型或消耗 quota。
瀏覽器只持久保存帳號範圍內的 requestId；payload、圖片預覽及草稿保留在 modal 記憶體。

## 操作與回應語意

- 純文字 `analyze` 沿用既有單筆支出／補問流程；不是多筆純文字擷取。
  `needs_input` 的 `question` 為 1–300 字元，`issues` 為欄位原因，補答放入 bounded history。
- 圖片 `analyze` 的「一筆」是收據上的一個消費品項（多品項收據會拆成多筆草稿）。
  只有一筆且完整時直接寫入，回 `created`；多筆或任一不完整時回 `drafts`。
  所有圖片均非收據且沒有草稿時回 `rejected`／`not_a_receipt`；超過 20 筆回 `too_many_drafts`。
- `revise` 依 text 與目前 drafts 重新擷取，不寫入支出；即使只剩一筆完整草稿也回 `drafts`。
  既有草稿變更或新增時可帶 `updated:true`，合併來源可保留 `mergedFrom`。
- `commit` 不呼叫模型，重新檢查草稿值；無效時整批拒絕，
  `draftIssues` 是 `{draftId,issues:[{field,code}]}` 陣列。
  通過後以批次 RPC 寫入，`created.metadata` 為 null。

`created` 的 `expenses` 為 1–20 筆完整 ExpenseRow，另有布林 `replayed`；
`drafts` 的 `reason` 在多筆時為 `multiple`，單筆未完成為 `incomplete`。
非 null metadata 固定含 `model,promptVersion,inputTokens,outputTokens,elapsedMs`，
token 數可為 null，其餘數值為非負整數。
`rejected.issues` 至少一項，code 接受 `missing,invalid,unknown_member,ambiguous_member,unsupported,configuration,not_a_receipt,too_many_drafts`。
JSON rejected 使用 HTTP 422；其他正常結果為 200。

SSE 每 frame 使用 `event` 與 JSON `data`：

- `analysis_delta`：`{requestId,seq,text}`，seq 從 0 連續遞增，累積最多 200 Unicode code points；
  僅為使用者摘要，不是 provider thought 或寫入判準。目前圖片／草稿 graph 不產生這類片段，純文字可產生。
- `persisting`：`{status:"persisting",requestId}`，在 RPC 前送出。
- `result`：完整 v3 回應；草稿、補問、拒絕、回放可直接終結而沒有 persisting。
- `error`：`{error:{code,uncertain}}`；串流接受後的錯誤仍為 HTTP 200，接受前使用 HTTP JSON 錯誤。

開始 RPC 後斷線不取消已接受的 in-process task，但仍受 deadline 與程序生命週期限制；
這不是 durable background execution。逾時可能回 `persist_uncertain`，需查詢／同 payload 重試。

## 草稿欄位與驗證

八欄均必須存在，每欄 value 可以是 null；缺少的資訊用 state 表示，不是省略整個欄位。
`recognized` 表示已辨識，`unrecognized` 表示無法辨識，`missing` 表示缺少，
`explicit_null` 表示明確清除且 value 必須為 null。
`source` 僅為 `image,text,default,user`；`confidence` 為 null 或 0–1 的有限數字。
`date.defaulted` 必須是 null、`unreadable` 或 `future`。

| 欄位              | 非 null value 的 parser 限制                                                |
| ----------------- | --------------------------------------------------------------------------- |
| note              | trim／NFC 後 1–200 字元                                                     |
| amount            | 正的安全整數；服務端另限制不超過 9,999,999,999                              |
| currency          | 三個大寫英文字母；記帳只接受 TWD                                            |
| date              | 有效 YYYY-MM-DD，年份至少 0100；記帳不可為未來日期                          |
| categoryId        | trim／NFC 後 1–1024 字元；服務端須為現有支出分類                            |
| scope             | personal 或 household                                                       |
| payerEmail        | trim／NFC 後最多 320 字元、簡易 email 格式；須為已知成員，personal 須為本人 |
| splitMemberEmails | email 陣列；household 須至少兩個不同的已知成員                              |

`mergedFrom` 若存在是 1–20 個 UUID；`originalAmount` 若存在是 null 或
`{text,currency}`（text 最多 200 字元，currency 三碼大寫）。回應還需要
`status:complete|incomplete`、`issues:[{field,code}]`，可有布林 `updated`。
用戶端回傳的 computed 欄位不作為服務信任來源。

Draft issue code 為 `missing`、`unrecognized`、`low_confidence`、`missing_confidence`、
`date_defaulted`、`non_twd`、`invalid`、`unknown_member`、`not_equal_split`、`future_date`。
目前自動完整度檢查會標記低於 0.7 的 confidence、圖片已辨識卻無 confidence、
無法辨識日期的預設值，以及不合法／缺少的必要值。
`not_equal_split` 是契約可接受 code，目前 `drafts.py` 未產生它；分攤金額由服務計算平分。
`commit` 以 value 驗證，不以 confidence、state 或 defaulted 阻擋有效值。

圖片正規化會將正數小數金額向上取整並保存 originalAmount；非 TWD 保留並標記。
缺少 currency／scope／payer 會預設 TWD／personal／本人；不合法日期預設台灣當日並標記
`unreadable`，未來日期改當日並標記 `future`。不要將圖片規則套在純文字日期補問上。
精確正規化、預設值與錯誤對應以程式為準：
`packages/semantic-entry-contract/src/index.ts`、
`services/semantic-entry/semantic_entry/contracts.py`、`drafts.py`、`graph_v3.py`、`handler.py`、`images.py`。

## 上傳端點

`POST /semantic-entry/uploads` 使用同一個 Supabase Bearer，接受 `{files:[{contentType,size}]}`。
每次 1–4 張，僅 JPEG／PNG／WebP；每張正整數 bytes，最多 10 MiB，合計最多 20 MiB。
回應 `{uploads:[{path,url,expiresAt,requiredHeaders}]}` 與輸入順序相同。
用戶端只以 requiredHeaders 對 HTTPS signed URL PUT 圖片，不附 Authorization；
後續 v3 analyze 的 images 僅送 path，不送 generation。上傳失敗不代表有支出寫入。

上傳 JSON body 另限 4096 bytes。路徑只能是 `uploads/<已驗證 user id>/<檔名>`，
檔名為 1–200 個允許的英數、點、底線、連字號且首字為英數，不接受 `..`。
analyze 不接受重複路徑。服務先檢查 metadata，再依讀取的 generation 下載、驗證大小與圖片 magic bytes。

| HTTP | code                 | 條件                                      |
| ---- | -------------------- | ----------------------------------------- |
| 400  | invalid_request      | 格式不符、非正整數大小或重複圖片路徑      |
| 400  | body_too_large       | 超過端點 body 限制                        |
| 400  | image_limit          | 張數超限或合計超過 20 MiB                 |
| 401  | unauthorized         | 缺少有效 Bearer／驗證失敗                 |
| 403  | origin_forbidden     | Origin 不在服務 allowlist                 |
| 403  | image_forbidden_path | 圖片路徑不屬於 caller 或格式不允許        |
| 404  | image_not_found      | 分析時物件不存在                          |
| 409  | image_changed        | generation 改變或下載長度不符             |
| 413  | image_too_large      | 單張超過 10 MiB，或 metadata 大小非正     |
| 415  | image_unsupported    | MIME 或圖片 signature 不支援              |
| 502  | image_configuration  | 未設定 image store 或圖片 deadline 不合法 |
| 502  | image_error          | 簽署／metadata／下載錯誤                  |
| 504  | image_error          | 上傳 URL 端點逾時                         |

以上錯誤使用 `{error:{code,uncertain}}`；另可能回共用身分、membership 或服務錯誤，
以 `handler.py`、`images.py`、`supabase.py` 為準。上傳成功不表示已記帳；
URL 15 分鐘到期不代表物件刪除，bucket CORS 與 lifecycle 由 operator 設定。
