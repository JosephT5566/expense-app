import { writable, get } from 'svelte/store';
import type { ExpenseRow, ExpenseQuery, PageResult } from '$lib/types/expense';
import { listExpenses, toggleSettled, bulkToggleSettled } from '$lib/data/expenses.fetcher';
import { taiwanMonthBoundsISO } from '$lib/utils/dates';

function createExpensesStore() {
	const items = writable<ExpenseRow[]>([]);
	const nextCursor = writable<string | null>(null);
	const loading = writable(false);
	const error = writable<unknown>(null);
	const _lastQuery = writable<ExpenseQuery | null>(null);

	async function load(q: ExpenseQuery) {
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
	
	async function loadThisMonth() {
		const today = new Date();
		const { from, to } = taiwanMonthBoundsISO(today.getFullYear(), today.getMonth() + 1);
		await load({ from, to });
	}

	async function loadMore() {
		const q = get(_lastQuery);
		const cursor = get(nextCursor);
		if (!q || !cursor) {
			return;
		}
		loading.set(true);
		try {
			const page = await listExpenses({ ...q, cursor });
			items.update((prev) => [...prev, ...page.items]);
			nextCursor.set(page.nextCursor);
		} finally {
			loading.set(false);
		}
	}

	/** 標記單筆結清（optimistic update） */
	async function markSettled(id: string, next: boolean) {
		items.update((prev) => prev.map((x) => (x.id === id ? { ...x, is_settled: next } : x)));
		try {
			await toggleSettled(id, next);
		} catch (e) {
			// 回滾
			items.update((prev) =>
				prev.map((x) => (x.id === id ? { ...x, is_settled: !next } : x))
			);
			throw e;
		}
	}

	/** 批次切換結清（ids 或 日期區間） */
	async function markSettledBulk(
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

	function reset() {
		items.set([]);
		nextCursor.set(null);
		error.set(null);
	}

	return {
		items,
		nextCursor,
		loading,
		error,
		load,
		loadThisMonth,
		loadMore,
		markSettled,
		markSettledBulk,
		reset,
	};
}

export const expensesStore = createExpensesStore();
