export type Currency = 'TWD' | 'USD' | 'GBP' | 'EUR';

export type ExpenseScope = 'household' | 'personal';

export type ShareEntry = Record<string, number>;
/** key: user email（依你的 shares_json 內容而定） */
/** value: amount（若是比例制，可以事先換算成金額存入） */

export interface ExpenseRow {
	id: string;
	payer_email: string; // 建立者
	note: string; // 主要內容
	amount: number; // 總額（原始額）
	currency: Currency;
	ts: string; // ISO date
	scope: ExpenseScope; // 'household' | 'personal'
	shares_json: ShareEntry; // 僅能看到自己「有參與」的（RLS 篩）
	notes?: string;
	category_id?: string;
	meta: string;
	created_at: string; // ISO
	updated_at: string; // ISO
	is_settled: boolean; // 是否已標記結清
}

/** 查詢條件（前端 store / fetcher 共用） */
export interface ExpenseQuery {
	from?: string; // inclusive ISO date
	to?: string; // inclusive ISO date
	scope?: ExpenseScope | 'all';
	search?: string;
	limit?: number;
	cursor?: string | null; // 用於分頁（以 occurred_at,id 為複合游標）
	settled?: 'all' | 'only_settled' | 'only_unsettled';
}

export interface PageResult<T> {
	items: T[];
	nextCursor: string | null;
}
