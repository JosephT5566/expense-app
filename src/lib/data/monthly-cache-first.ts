// src/lib/data/monthly-cache-first.ts
import { browser } from '$app/environment';
import { getExpenseFromCache, setExpenseCache, isStale } from '$lib/cache/monthlyExpense';
import { listExpensesMonthly } from '$lib/data/expenses.fetcher';

// before using, check the store first.
export async function getMonthlyFromCacheFirst(monthKey: string) {
	// 先嘗試命中（記憶體或 IDB），命中就馬上回資料
	if (browser) {
		const cached = await getExpenseFromCache(monthKey);
		if (cached) {
			// 命中但過期 → 背景 revalidate
			if (isStale(monthKey)) {
				revalidateInBackground(monthKey).catch(() => {});
			}
			return cached;
		}
	}

	console.log('monthly cache miss for', monthKey);
	// 沒命中 → 正式請求
	const fresh = await listExpensesMonthly(monthKey);
	if (browser) {
		await setExpenseCache(monthKey, fresh.items);
	}
	return fresh.items;
}

export async function revalidateInBackground(monthKey: string) {
	const fresh = await listExpensesMonthly(monthKey);
	await setExpenseCache(monthKey, fresh.items);
}
