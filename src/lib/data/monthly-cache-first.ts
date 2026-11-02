// src/lib/data/monthly-cache-first.ts
import { getExpenseFromCache, isStale } from '$lib/cache/monthlyExpense';
import { listExpensesMonthly } from '$lib/data/expenses.fetcher';
import type { ExpenseRow } from '$lib/types/expense';
import type { MonthSnapshot } from '$lib/stores/expenses.store';

// Building blocks for `loadMonthIntoStore` / `ensureMonthLoaded` in `month-loader.ts`, which
// decide what reaches the store and the cache. Use those for store-backed views.

/** Read a month from memory or IndexedDB. `stale` is true after ten minutes. */
export async function readMonthFromCache(
	monthKey: string
): Promise<{ rows: ExpenseRow[]; stale: boolean } | null> {
	const rows = await getExpenseFromCache(monthKey);
	if (!rows) {
		return null;
	}
	return { rows, stale: isStale(monthKey) };
}

/**
 * Fetch the first page (up to 500 rows) of a month from Supabase. When the server reports more
 * rows (`nextCursor`), the snapshot is marked incomplete; full pagination is not done here.
 */
export async function fetchMonthSnapshot(monthKey: string): Promise<MonthSnapshot> {
	const page = await listExpensesMonthly(monthKey);
	return { rows: page.items, complete: page.nextCursor === null };
}
