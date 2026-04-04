# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project in the current directory
npx sv create

# create a new project in my-app
npx sv create my-app
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

# Supabase
## Tables

**public.expenses**

紀錄每一筆消費的原始資訊。eg:
- `payer_email`: 付錢的人。
- `shares_json`: 以 JSON 格式儲存的分攤比例，方便前端一次性寫入。

**public.expense_shares (從表)**

透過 Trigger (`trg_sync_shares`) **自動**從主表的 `shares_json` 展開。

目的: 將 JSON 攤平成資料列，以便進行高效的 SQL 聚合運算（如 SUM, GROUP BY）

Columns:
- `uuid`: unique value
- `expense_id`: 對應到 `expense` table 的 uuid，假設 user 有 2 人，那麼同樣的 `expense_id` 在這表中就會存在2個，對應到各別用戶的花費

## Security & RLS

為了確保資料隱私，我們採用了 Supabase 的 Row Level Security (RLS)：訪問控制: 透過自定義函數 `email_allowed()` 檢查當前使用者是否在 `app_settings` 的白名單內。

## View
**v_monthly_member_balances**

 （**SECURITY INVOKER**，使 view 強制遵循底層 table 的 RLS 政策。）

該視圖透過 CTE (Common Table Expression) 處理複雜的財務加總
核心計算公式：`Net = sum(Paid) - sum(Owed)`
- 雙重聯集 (Union All):
    1. Paid 來源: 取自 `expenses` 表，將整筆金額歸給 `payer_email。`
    2. Owed 來源: 取自 `expense_shares` 表。因為 `expense_shares` 無記錄詳資料，所以又透過 `JOIN` 回主表取得月份與分類，將分攤金額歸給 `user_email`