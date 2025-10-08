export type Currency = 'TWD' | 'USD' | 'GBP' | 'EUR';

export type ExpenseScope = 'household' | 'personal';

export type SplitMode = 'equal' | 'custom'; // equal: 平均分攤；custom：shares_json 內各自比例/金額

export interface ShareEntry {
	/** 參與者 uid 或 email（依你的 shares_json 內容而定） */
	id: string;
	/** 金額（若是比例制，可以事先換算成金額存入） */
	amount: number;
}

export interface ExpenseRow {
	id: string;
	owner_id: string; // 建立者
	title: string;
	amount: number; // 總額（原始額）
	currency: Currency;
	ts: string; // ISO date
	scope: ExpenseScope; // 'household' | 'personal'
	split_mode: SplitMode; // 'equal' | 'custom'
	shares_json: ShareEntry[]; // 僅能看到自己「有參與」的（RLS 篩）
	is_settled: boolean; // 是否已標記結清
	notes: string | null;
	created_at: string; // ISO
	updated_at: string; // ISO
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
