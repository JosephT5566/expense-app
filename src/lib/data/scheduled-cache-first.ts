import { browser } from '$app/environment';
import {
	getScheduledExpensesFromCache,
	isScheduledExpensesCacheStale,
	setScheduledExpensesCache
} from '$lib/cache/scheduledExpenses';
import { listScheduledExpenses } from '$lib/data/scheduled-expenses.fetcher';
import Logger from '$lib/utils/logger';

export async function getPendingScheduledFromCacheFirst() {
	if (browser) {
		const cached = await getScheduledExpensesFromCache();
		if (cached) {
			if (isScheduledExpensesCacheStale()) {
				revalidatePendingScheduledInBackground().catch(() => {});
			}
			return cached;
		}
	}

	Logger.log('scheduled expenses cache miss, fetch from supabase');
	const fresh = await listScheduledExpenses({
		status: 'pending',
		limit: 500
	});

	if (browser) {
		await setScheduledExpensesCache(fresh.items);
	}

	return fresh.items;
}

export async function revalidatePendingScheduledInBackground() {
	const fresh = await listScheduledExpenses({
		status: 'pending',
		limit: 500
	});
	await setScheduledExpensesCache(fresh.items);
	return fresh.items;
}
