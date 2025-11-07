import { writable, get } from 'svelte/store';
import { type ExpenseRow, type ExpenseQuery, type PageResult, NewExpense } from '$lib/types/expense';
import { listExpenses, toggleSettled, bulkToggleSettled } from '$lib/data/expenses.fetcher';
import { taiwanMonthBoundsISO } from '$lib/utils/dates';
import { persistExpensePatch } from '$lib/cache/monthlyExpense';

export const items = writable<ExpenseRow[]>([]);
export const nextCursor = writable<string | null>(null);
export const loading = writable(false);
export const error = writable<unknown>(null);
export const _lastQuery = writable<ExpenseQuery | null>(null);
export const monthlyItems = writable(new Map<string, ExpenseRow[]>());

export function setMonthlyItemsFromLoad(data: ExpenseRow[]) {
	items.set(data);
}

export function setMoreItems(data: ExpenseRow[]) {
	items.update((prev) => {
		const map = new Map(prev.map((r) => [r.id, r]));
		for (const r of data) {
			map.set(r.id, r);
		}
		return Array.from(map.values());
	});
}

export async function load(q: ExpenseQuery) {
	loading.set(true);
	error.set(null);
	try {
		_lastQuery.set(q);
		const page: PageResult<ExpenseRow> = await listExpenses(q);
		items.set(page.items);
		nextCursor.set(page.nextCursor);
	} catch (e) {
		error.set(e);
	} finally {
		loading.set(false);
	}
}

async function loadAndUpdate(q: ExpenseQuery) {
	loading.set(true);
	error.set(null);
	try {
		_lastQuery.set(q);
		const page: PageResult<ExpenseRow> = await listExpenses(q);
		items.update((prev) => {
			const map = new Map(prev.map((r) => [r.id, r]));
			for (const r of page.items) {
				map.set(r.id, r);
			}
			return Array.from(map.values());
		});
	} catch (e) {
		error.set(e);
	} finally {
		loading.set(false);
	}
}

export async function loadThisMonth() {
	console.log('Load this month');
	const today = new Date();
	const { from, to } = taiwanMonthBoundsISO(today.getFullYear(), today.getMonth() + 1);
	await load({ from, to });
}

export async function loadMore() {
	const q = get(_lastQuery);
	const cursor = get(nextCursor);
	if (!q || !cursor) {
		return;
	}
	loading.set(true);
	try {
		const page = await listExpenses({ ...q, cursor });
		items.update((prev) => {
			const map = new Map(prev.map((r) => [r.id, r]));
			for (const r of page.items) {
				map.set(r.id, r);
			}
			return Array.from(map.values());
		});
		nextCursor.set(page.nextCursor);
	} finally {
		loading.set(false);
	}
}

/** 標記單筆結清（optimistic update） */
export async function markSettled(id: string, next: boolean) {
	items.update((prev) => prev.map((x) => (x.id === id ? { ...x, is_settled: next } : x)));
	try {
		await toggleSettled(id, next);
	} catch (e) {
		// 回滾
		items.update((prev) => prev.map((x) => (x.id === id ? { ...x, is_settled: !next } : x)));
		throw e;
	}
}

/** 批次切換結清（ids 或 日期區間） */
export async function markSettledBulk(
	params: { ids: string[]; next: boolean } | { from: string; to: string; next: boolean }
) {
	// 前端 optimistic 更新（簡化：若是日期區間，直接把畫面中符合區間的先改）
	if ('ids' in params) {
		items.update((prev) =>
			prev.map((x) => (params.ids.includes(x.id) ? { ...x, is_settled: params.next } : x))
		);
	} else {
		items.update((prev) =>
			prev.map((x) => {
				const inRange =
					(!params.from || x.ts >= params.from) && (!params.to || x.ts <= params.to);
				return inRange ? { ...x, is_settled: params.next } : x;
			})
		);
	}
	try {
		await bulkToggleSettled(params);
	} catch (e) {
		// 錯誤時重新載入（最保險）
		const q = get(_lastQuery);
		if (q) {
			await load(q);
		}
		throw e;
	}
}

/** 以單筆結果更新 store：若存在則覆蓋，否則插入，並依 ts DESC, id DESC 排序 */
export function upsertOne(row: ExpenseRow) {
	let oldRow: ExpenseRow | null = null;
	items.update((prev) => {
		const idx = prev.findIndex((x) => x.id === row.id);
		let next = prev.slice();

		if (idx >= 0) {
			// found existing row
			oldRow = prev[idx];
			next[idx] = row;
		} else {
			next = [row, ...next];
		}

		// I think we can save the sorting for performance
		// next.sort((a, b) => {
		// 	if (a.ts !== b.ts) {
		// 		return a.ts < b.ts ? 1 : -1; // ts DESC
		// 	}
		// 	if (a.id !== b.id) {
		// 		return a.id < b.id ? 1 : -1; // id DESC（穩定）
		// 	}
		// 	return 0;
		// });
		return next;
	});
	console.log('Upserted expense', row, oldRow);

	persistExpensePatch(oldRow, row).catch((e) => {
		console.error('Failed to persist expense patch to cache', e);
	});
}

/** 載入指定年份月份的資料，取代目前 items */
export async function loadMonth(year: number, month: number) {
	const { from, to } = taiwanMonthBoundsISO(year, month);
	await load({ from, to, limit: 1000, settled: 'all' });
}

/** 依日期字串 (YYYY-MM-DD 或含時間的 ISO) 載入其所屬月份 */
export async function loadMonthByDate(dateISO: string) {
	// 允許 'YYYY-MM-DD' 或完整 ISO；只需取得台灣年月
	const d = new Date(dateISO);
	const year = d.getFullYear();
	const month = d.getMonth() + 1; // 1-12
	const { from, to } = taiwanMonthBoundsISO(year, month);
	await loadAndUpdate({ from, to });
}

export function reset() {
	items.set([]);
	nextCursor.set(null);
	error.set(null);
}

export function getTodayExpense() {
	const today = new Date();
	const todayStr = today.toISOString().slice(0, 10);
	return get(items).find((e) => e.ts.slice(0, 10) === todayStr);
}

export function getExpenseById(id: string) {
	return get(items).find((e) => e.id === id) || new NewExpense();
}

export function getMonthExpenses(year?: number, month?: number) {
	const selectedYear = year ? year : new Date().getFullYear();
	const selectedMonth = month ? month : new Date().getMonth() + 1;

	const { from, to } = taiwanMonthBoundsISO(selectedYear, selectedMonth);
	return get(items).filter((e) => e.ts >= from && e.ts <= to);
}

export function hasMonthExpenses(year: number, month: number) {
	const selectedYear = year ? year : new Date().getFullYear();
	const selectedMonth = month ? month : new Date().getMonth() + 1;

	const { from, to } = taiwanMonthBoundsISO(selectedYear, selectedMonth);
	return get(items).some((e) => e.ts >= from && e.ts <= to);
}

export function clearAll() {
	monthlyItems.set(new Map());
	items.set([]);
	nextCursor.set(null);
	error.set(null);
	_lastQuery.set(null);
}
