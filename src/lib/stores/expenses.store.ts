import { writable, get } from 'svelte/store';
import {
	type ExpenseRow,
	type ExpenseQuery,
	type PageResult,
	NewExpense
} from '$lib/types/expense';
import { listExpenses, toggleSettled, bulkToggleSettled } from '$lib/data/expenses.fetcher';
import { taiwanMonthBoundsISO, getTaiwanMonthKey, isWithinRange } from '$lib/utils/dates';
import { persistExpensePatch, persistExpenseDelete } from '$lib/cache/monthlyExpense';
import Logger from '$lib/utils/logger';

export const items = writable<ExpenseRow[]>([]);
export const nextCursor = writable<string | null>(null);
export const loading = writable(false);
export const error = writable<unknown>(null);
export const _lastQuery = writable<ExpenseQuery | null>(null);
export const monthlyItems = writable(new Map<string, ExpenseRow[]>());

// Local mutation count per Taiwan month. A month refresh records it before fetching and
// discards its snapshot when a local upsert or delete for that month happened meanwhile.
const monthMutations = new Map<string, number>();
function bumpMonth(row: ExpenseRow | null) {
	if (row) {
		const key = getTaiwanMonthKey(row.ts);
		monthMutations.set(key, (monthMutations.get(key) ?? 0) + 1);
	}
}
export function monthMutationVersion(monthKey: string) {
	return monthMutations.get(monthKey) ?? 0;
}

// Taiwan month keys whose complete monthly snapshot (cache or server) has been merged into
// `items`. A single upserted row (for example an approved scheduled expense) does not mark a
// month as loaded, so month views still fetch the whole month. A stale cache hit counts as
// loaded for display while its background revalidation runs.
const loadedMonths = new Set<string>();
// Months whose next load must fetch from the server, skipping the cache: a background
// revalidation failed, or the server reported more rows than one page.
const monthsNeedingRevalidation = new Set<string>();
// Bumped by `clearAll` so loads started for a previous account cannot write afterwards.
let storeGeneration = 0;

export function isMonthLoaded(monthKey: string) {
	return loadedMonths.has(monthKey);
}

export function markMonthLoaded(monthKey: string) {
	loadedMonths.add(monthKey);
}

export function monthNeedsRevalidation(monthKey: string) {
	return monthsNeedingRevalidation.has(monthKey);
}

/** Forget that the month is loaded and make its next load fetch from the server. */
export function markMonthNeedsRevalidation(monthKey: string) {
	loadedMonths.delete(monthKey);
	monthsNeedingRevalidation.add(monthKey);
}

export function storeGenerationVersion() {
	return storeGeneration;
}

/**
 * A month load in flight. Local upserts and deletes touching the month while it is active are
 * recorded by id, so the load's snapshot (fetched or read before them) never overwrites them.
 */
export type MonthLoadToken = {
	readonly monthKey: string;
	readonly generation: number;
	readonly touched: Set<string>;
};
const activeLoads = new Set<MonthLoadToken>();

export function beginMonthLoad(monthKey: string): MonthLoadToken {
	const token = { monthKey, generation: storeGeneration, touched: new Set<string>() };
	activeLoads.add(token);
	return token;
}

export function endMonthLoad(token: MonthLoadToken) {
	activeLoads.delete(token);
}

function recordLocalChange(id: string, rows: (ExpenseRow | null)[]) {
	if (activeLoads.size === 0) {
		return;
	}
	const months = new Set(rows.filter((r) => r !== null).map((r) => getTaiwanMonthKey(r.ts)));
	for (const token of activeLoads) {
		// Unknown month (row not in the store): record it everywhere to stay conservative.
		if (months.size === 0 || months.has(token.monthKey)) {
			token.touched.add(id);
		}
	}
}

export type MonthSnapshot = {
	rows: ExpenseRow[];
	/** False when the server reported more rows than this page (only the first page is read). */
	complete: boolean;
};

/**
 * Apply a month snapshot to `items`. Snapshot rows are deduplicated by id (the last one wins)
 * and replace store rows with the same id. Rows changed locally since `token` began keep their
 * store version (or stay deleted). With `mode: 'replace'` and a complete snapshot (fresh from
 * the server), rows of that month missing from the snapshot are removed; `merge` (cache hits)
 * and incomplete snapshots never remove rows. A complete snapshot marks the month loaded; an
 * incomplete one leaves it unloaded and needing revalidation.
 *
 * Returns the month's rows now in the store (suitable for the cache), or null when the token
 * belongs to an earlier store generation (sign-out) and nothing was applied.
 */
export function applyMonthSnapshot(
	token: MonthLoadToken,
	snapshot: MonthSnapshot,
	mode: 'merge' | 'replace'
): ExpenseRow[] | null {
	if (token.generation !== storeGeneration) {
		return null;
	}
	const { monthKey, touched } = token;
	const fresh = new Map<string, ExpenseRow>();
	for (const row of snapshot.rows) {
		if (!touched.has(row.id)) {
			fresh.set(row.id, row);
		}
	}
	const removeMissing = mode === 'replace' && snapshot.complete;
	let monthRows: ExpenseRow[] = [];
	items.update((prev) => {
		const kept = prev.filter((row) => {
			if (fresh.has(row.id)) {
				return false;
			}
			return !(
				removeMissing &&
				getTaiwanMonthKey(row.ts) === monthKey &&
				!touched.has(row.id)
			);
		});
		const next = [...kept, ...fresh.values()];
		monthRows = next.filter((row) => getTaiwanMonthKey(row.ts) === monthKey);
		return next;
	});
	if (snapshot.complete) {
		loadedMonths.add(monthKey);
		if (mode === 'replace') {
			monthsNeedingRevalidation.delete(monthKey);
		}
	} else {
		markMonthNeedsRevalidation(monthKey);
		Logger.warn(
			{ prod: true },
			`Month ${monthKey} has more rows than one page (${snapshot.rows.length}); it is not treated as complete.`
		);
	}
	return monthRows;
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
	Logger.log('Load this month');
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
				const inRange = isWithinRange(x.ts, params.from, params.to);
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
	bumpMonth(oldRow);
	bumpMonth(row);
	recordLocalChange(row.id, [oldRow, row]);
	Logger.log('Upserted expense', row, oldRow);

	persistExpensePatch(oldRow, row).catch((e) => {
		Logger.error('Failed to persist expense patch to cache', e);
	});
}

/** 以多筆結果更新 store：若存在則覆蓋，否則插入 */
export function upsertMany(rows: ExpenseRow[]) {
	const oldRows: ExpenseRow[] = [];
	items.update((prev) => {
		const map = new Map(prev.map((r) => [r.id, r]));
		for (const row of rows) {
			const existing = map.get(row.id);
			if (existing) {
				oldRows.push(existing);
			}
			map.set(row.id, row);
		}
		return Array.from(map.values());
	});
	oldRows.forEach(bumpMonth);
	rows.forEach(bumpMonth);
	for (const row of rows) {
		recordLocalChange(row.id, [oldRows.find((old) => old.id === row.id) ?? null, row]);
	}
}

export function deleteOne(id: string) {
	let removed: ExpenseRow | null = null;
	items.update((prev) => {
		const next: ExpenseRow[] = [];
		for (const row of prev) {
			if (row.id === id) {
				removed = row;
				continue;
			}
			next.push(row);
		}
		return next;
	});

	bumpMonth(removed);
	recordLocalChange(id, [removed]);
	if (removed) {
		persistExpenseDelete(removed).catch((e) => {
			Logger.error('Failed to remove expense from cache', e);
		});
	}
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
	return get(items).filter((e) => isWithinRange(e.ts, from, to));
}

export function clearAll() {
	loadedMonths.clear();
	monthsNeedingRevalidation.clear();
	activeLoads.clear();
	storeGeneration += 1;
	monthlyItems.set(new Map());
	items.set([]);
	nextCursor.set(null);
	error.set(null);
	_lastQuery.set(null);
}
