export type Currency =
	| 'TWD'
	| 'USD'
	| 'JPY'
	| 'EUR'
	| 'GBP'
	| 'KRW'
	| 'CNY'
	| 'HKD'
	| 'SGD'
	| 'THB';

export type ExpenseScope = 'household' | 'personal';
export type ScheduledExpenseKind = 'one_time' | 'recurring';
export type ScheduledExpenseRecurrence = 'daily' | 'weekly' | 'monthly';
export type ScheduledExpenseStatus = 'pending' | 'confirmed' | 'cancelled';

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
	category_id?: string | null;
	meta: string;
	created_at: string; // ISO
	updated_at: string; // ISO
	is_settled: boolean; // 是否已標記結清
}

export interface ScheduledExpenseRow {
	id: string;
	owner_email: string;
	payer_email: string;
	note: string;
	amount: number;
	currency: Currency;
	scheduled_for: string;
	timezone: string;
	scope: ExpenseScope;
	shares_json: ShareEntry;
	category_id?: string | null;
	kind: ScheduledExpenseKind;
	recurrence_rule?: ScheduledExpenseRecurrence | null;
	recurrence_weekday?: number | null;
	recurrence_month_day?: number | null;
	status: ScheduledExpenseStatus;
	created_expense_id?: string | null;
	created_at: string;
	updated_at: string;
}

export interface PreviewExpense extends Partial<ExpenseRow> {
	isGrouped?: boolean;
	groupId?: number;
	isHidden?: boolean;
}

export type PreviewGroupExpense = Record<number, PreviewExpense>;

export class NewExpense implements Partial<ExpenseRow> {
	currency: Currency;
	amount: number;
	category_id: string;
	scope: ExpenseScope;
	note: string;
	is_settled: boolean;
	shares_json: ShareEntry;
	ts: string;
	payer_email?: string;

	constructor() {
		this.currency = 'TWD';
		this.amount = 0;
		this.category_id = '';
		this.scope = 'personal';
		this.note = '';
		this.is_settled = false;
		this.shares_json = {};
		this.ts = new Date().toISOString();
	}
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

export type UnrecognizedExtraction = {
	state: 'unrecognized';
};

export type RecognizedExtraction<T> = {
	state: 'recognized';
	value: T;
};

/**
 * A property containing this type may also be omitted. Omission and `null`
 * intentionally retain their distinct meanings from the extraction API.
 */
export type ExtractionValue<T> = null | UnrecognizedExtraction | RecognizedExtraction<T>;

export interface ReceiptMerchant {
	name: string;
}

export interface ReceiptTotals {
	grand_total: string;
}

export interface ReceiptLineItem {
	description?: ExtractionValue<string>;
	quantity?: ExtractionValue<string>;
	unit_price?: ExtractionValue<string>;
	line_total?: ExtractionValue<string>;
}

export interface Receipt {
	merchant?: ExtractionValue<ReceiptMerchant>;
	purchase_date?: ExtractionValue<string>;
	totals?: ExtractionValue<ReceiptTotals>;
	currency?: ExtractionValue<Currency>;
	line_items?: ExtractionValue<ReceiptLineItem[]>;
}

export type ReceiptAnalysisResult =
	| {
		document_type: 'receipt';
		receipt: Receipt;
	}
	| {
		document_type: 'not_a_receipt';
	};
