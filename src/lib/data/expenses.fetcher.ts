import { supabase } from '$lib/supabase/supabaseClient';
import type { ExpenseRow, ExpenseQuery, PageResult } from '$lib/types/expense';
import { encodeCursor, decodeCursor } from '$lib/utils/dates';

const TABLE = 'expenses';

export async function listExpenses(q: ExpenseQuery): Promise<PageResult<ExpenseRow>> {
	const limit = q.limit ?? 50;

	// 基礎 query：僅回傳使用者可見（RLS）欄位
	let query = supabase
		.from(TABLE)
		.select('*')
		.order('occurred_at', { ascending: false })
		.order('id', { ascending: false })
		.limit(limit + 1);

	if (q.from) query = query.gte('occurred_at', q.from);
	if (q.to) query = query.lte('occurred_at', q.to);
	if (q.scope && q.scope !== 'all') query = query.eq('scope', q.scope);
	if (q.search) query = query.ilike('title', `%${q.search}%`);

	if (q.settled === 'only_settled') query = query.eq('is_settled', true);
	if (q.settled === 'only_unsettled') query = query.eq('is_settled', false);

	// cursor-based pagination（以 occurred_at + id）
	if (q.cursor) {
		const c = decodeCursor(q.cursor); // { occurred_at, id }
		// 小心順序與排序方向一致（descending）
		// 若要兼容等值，採用 (occurred_at < c.occurred_at) OR (occurred_at = c.occurred_at AND id < c.id)
		// Supabase 目前不支援複合 where OR 的 server-side index merge，簡化用 occurred_at < cursor.occurred_at，再補相等情況
		query = query.lt('occurred_at', c.occurred_at);
	}

	const { data, error } = await query.returns<ExpenseRow[]>();
	if (error) throw error;

	let nextCursor: string | null = null;
	let items = data ?? [];

	if (items.length > limit) {
		const last = items[limit - 1];
		nextCursor = encodeCursor({ occurred_at: last.occurred_at, id: last.id });
		items = items.slice(0, limit);
	}

	return { items, nextCursor };
}

export async function getExpense(id: string): Promise<ExpenseRow | null> {
	const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();

	if (error) throw error;
	return data ?? null;
}

export interface UpsertExpenseInput {
	id?: string;
	title: string;
	amount: number;
	currency: string;
	occurred_at: string;
	scope: 'household' | 'personal';
	split_mode: 'equal' | 'custom';
	shares_json: unknown; // 建議沿用 ShareEntry[] 型別，但若要兼容 RPC，可設 unknown
	is_settled?: boolean;
	notes?: string | null;
}

export async function upsertExpense(input: UpsertExpenseInput): Promise<ExpenseRow> {
	const payload = { ...input };
	const { data, error } = await supabase.from(TABLE).upsert(payload).select().single();
	if (error) throw error;
	return data as ExpenseRow;
}

export async function toggleSettled(id: string, next: boolean): Promise<void> {
	const { error } = await supabase.from(TABLE).update({ is_settled: next }).eq('id', id);
	if (error) throw error;
}

/** 批次切換結清（支援 ids 或日期區間）。若你有 RPC，可改呼叫 rpc('toggle_settled_bulk', ...) */
export async function bulkToggleSettled(
	params: { ids: string[]; next: boolean } | { from: string; to: string; next: boolean }
): Promise<number> {
	if ('ids' in params) {
		const { error, count } = await supabase
			.from(TABLE)
			.update({ is_settled: params.next })
			.in('id', params.ids)
			.select('id');
		if (error) throw error;
		return count ?? 0;
	} else {
		const { error, count } = await supabase
			.from(TABLE)
			.update({ is_settled: params.next })
			.gte('occurred_at', params.from)
			.lte('occurred_at', params.to)
			.select('id');
		if (error) throw error;
		return count ?? 0;
	}
}

/** 取得月結摘要（前端彙總版；若有 SQL/RPC 更快） */
export async function fetchMonthlySummary(
	year: number,
	month: number,
	scope: 'all' | 'household' | 'personal' = 'all'
) {
	const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
	const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();

	const res = await listExpenses({ from: start, to: end, scope, limit: 1000, settled: 'all' });
	const total = res.items.reduce((acc, e) => acc + e.amount, 0);
	const household = res.items
		.filter((e) => e.scope === 'household')
		.reduce((a, e) => a + e.amount, 0);
	const personal = total - household;

	return { total, household, personal, count: res.items.length };
}
