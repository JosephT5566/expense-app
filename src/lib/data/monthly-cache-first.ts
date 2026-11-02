// src/lib/data/monthly-cache-first.ts
import { browser } from '$app/environment';
import Logger from '$lib/utils/logger';
import { getExpenseFromCache, setExpenseCache, isStale } from '$lib/cache/monthlyExpense';
import { listExpensesMonthly } from '$lib/data/expenses.fetcher';
import type { ExpenseRow } from '$lib/types/expense';

export type MonthlyCacheFirstOptions = {
	/**
	 * Called after a stale cache hit has been revalidated in the background and the fresh
	 * rows were written to the cache. Lets callers publish them (e.g. into the expense store)
	 * without this module importing the store.
	 */
	onRevalidated?: (monthKey: string, rows: ExpenseRow[]) => void;
};

// Prefer `loadMonthIntoStore` / `ensureMonthLoaded` in `month-loader.ts` for store-backed views.
export async function getMonthlyFromCacheFirst(
	monthKey: string,
	options: MonthlyCacheFirstOptions = {}
) {
	// 先嘗試命中（記憶體或 IDB），命中就馬上回資料
	if (browser) {
		const cached = await getExpenseFromCache(monthKey);
		if (cached) {
			// 命中但過期 → 背景 revalidate
			if (isStale(monthKey)) {
				revalidateInBackground(monthKey, options.onRevalidated).catch(() => {});
			}
			return cached;
		}
	}

	Logger.log('monthly cache miss, fetch from supabase. key:', monthKey);
	// 沒命中 → 正式請求
	const fresh = await listExpensesMonthly(monthKey);
	if (browser) {
		await setExpenseCache(monthKey, fresh.items);
	}
	return fresh.items;
}

export async function revalidateInBackground(
	monthKey: string,
	onRevalidated?: MonthlyCacheFirstOptions['onRevalidated']
) {
	const fresh = await listExpensesMonthly(monthKey);
	await setExpenseCache(monthKey, fresh.items);
	onRevalidated?.(monthKey, fresh.items);
}
