import { supabase } from '$lib/supabase/supabaseClient';
import type {
	ExpenseRow,
	ExpenseQuery,
	PageResult,
	ShareEntry,
	ExpenseScope,
} from '$lib/types/expense';
import { encodeCursor, decodeCursor, taiwanMonthBoundsISO, decodeMonthKey } from '$lib/utils/dates';
import { isDev } from '$lib/utils/helpers';

const TABLE = 'expenses';

export async function listExpenses(q: ExpenseQuery): Promise<PageResult<ExpenseRow>> {
	if (isDev) {
		console.log('fetch expenses');
	}

	const limit = q.limit ?? 50;

	// 基礎 query：以 ts DESC, id DESC，並多抓 1 筆判斷是否有下一頁
	let query = supabase
		.from(TABLE)
		.select('*') // ← 不用 returns<T>()，之後在函式出口做型別斷言
		.order('ts', { ascending: false })
		.order('id', { ascending: false })
		.limit(limit + 1);

	if (q.from) {
		query = query.gte('ts', q.from);
	}
	if (q.to) {
		query = query.lte('ts', q.to);
	}
	if (q.scope && q.scope !== 'all') {
		query = query.eq('scope', q.scope);
	}
	if (q.search) {
		query = query.ilike('title', `%${q.search}%`);
	}

	if (q.settled === 'only_settled') {
		query = query.eq('is_settled', true);
	}
	if (q.settled === 'only_unsettled') {
		query = query.eq('is_settled', false);
	}

	// 遊標（以 ts + id 做穩定排序的 key，DESC）
	if (q.cursor) {
		const c = decodeCursor(q.cursor); // { ts, id }
		// Supabase/PostgREST 尚不支援複合比較 (A < a) OR (A = a AND B < b) 的單一呼叫，
		// 這裡用簡化策略：ts < cursor.ts（DESC 對應的下一頁）
		query = query.lt('ts', c.ts);
	}

	const { data, error } = await query;
	if (error) {
		throw error;
	}

	let items = (data ?? []) as ExpenseRow[];
	let nextCursor: string | null = null;

	if (items.length > limit) {
		const last = items[limit - 1];
		nextCursor = encodeCursor({ ts: last.ts, id: last.id });
		items = items.slice(0, limit);
	}

	return { items, nextCursor };
}

/**
 * 以「台灣時區」計算該月的 [from, to) 邊界，再呼叫現有的 listExpenses。
 * @param monthKey 例如 '2025-10'
 * @param q 其他查詢條件（會覆蓋預設），但不需提供 from/to
 */
export async function listExpensesMonthly(
	monthKey: string,
	q: Omit<ExpenseQuery, 'from' | 'to'> = {}
): Promise<PageResult<ExpenseRow>> {
	if (isDev) {
		console.log('fetch expenses for month', monthKey);
	}
	const { year, month } = decodeMonthKey(monthKey);
	const { from, to } = taiwanMonthBoundsISO(year, month);
	// 設定一個較合理的預設頁大小；也可沿用呼叫端提供的 q.limit
	const limit = q.limit ?? 500;

	return listExpenses({
		...q,
		limit,
		from, // 含當月 00:00:00 (台灣) 對應的 UTC ISO
		to, // 不含次月 00:00:00 (台灣) 對應的 UTC ISO
	});
}

export async function getExpense(id: string): Promise<ExpenseRow | null> {
	const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle(); // ← 這個 API 仍可用

	if (error) {
		throw error;
	}
	return (data as ExpenseRow) ?? null;
}

export interface UpsertExpenseInput {
	id?: string; // only provided when updating
	note: string;
	amount: number;
	currency: string;
	ts?: string;
	updated_at?: string;
	payer_email: string;
	scope: ExpenseScope;
	shares_json: ShareEntry;
	is_settled?: boolean;
	notes?: string;
	category_id: string;
}

export async function upsertExpense(input: UpsertExpenseInput): Promise<ExpenseRow> {
	const { data, error } = await supabase.from(TABLE).upsert(input).select().single(); // ← 回傳單筆新資料

	if (error) {
		throw error;
	}

	return data as ExpenseRow;
}

export async function toggleSettled(id: string, next: boolean): Promise<void> {
	const { error } = await supabase.from(TABLE).update({ is_settled: next }).eq('id', id);
	if (error) {
		throw error;
	}
}

export async function bulkToggleSettled(
	params: { ids: string[]; next: boolean } | { from: string; to: string; next: boolean }
): Promise<number> {
	if ('ids' in params) {
		const { error, count } = await supabase
			.from(TABLE)
			.update({ is_settled: params.next })
			.in('id', params.ids)
			.select('id');
		if (error) {
			throw error;
		}
		return count ?? 0;
	} else {
		const { error, count } = await supabase
			.from(TABLE)
			.update({ is_settled: params.next })
			.gte('ts', params.from)
			.lte('ts', params.to)
			.select('id');
		if (error) {
			throw error;
		}
		return count ?? 0;
	}
}

export async function fetchMonthlySummary(
	year: number,
	month: number,
	scope: 'all' | 'household' | 'personal' = 'all'
) {
	const { from, to } = taiwanMonthBoundsISO(year, month);

	const res = await listExpenses({ from, to, scope, limit: 1000, settled: 'all' });
	const total = res.items.reduce((acc, e) => acc + e.amount, 0);
	const household = res.items
		.filter((e) => e.scope === 'household')
		.reduce((a, e) => a + e.amount, 0);
	const personal = total - household;

	return { total, household, personal, count: res.items.length };
}
