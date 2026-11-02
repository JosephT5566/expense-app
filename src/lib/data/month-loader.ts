// src/lib/data/month-loader.ts
import type { ExpenseRow } from '$lib/types/expense';
import * as expensesStore from '$lib/stores/expenses.store';
import { getMonthlyFromCacheFirst } from '$lib/data/monthly-cache-first';
import Logger from '$lib/utils/logger';

type LoadMonthOptions = {
	/** Return false to drop the result (e.g. the page or account changed meanwhile). */
	isCurrent?: () => boolean;
};

const pendingMonths = new Map<string, Promise<ExpenseRow[]>>();

/**
 * Load a complete Taiwan month ('YYYY-MM') cache-first and merge it into the expense store,
 * then mark the month as loaded. A stale cache hit is returned at once; when its background
 * revalidation finishes, the fresh rows replace that month in the store unless a local write
 * to the month happened meanwhile (that snapshot would be older than the store).
 */
export function loadMonthIntoStore(
	monthKey: string,
	options: LoadMonthOptions = {}
): Promise<ExpenseRow[]> {
	const isCurrent = options.isCurrent ?? (() => true);
	const generation = expensesStore.storeGenerationVersion();
	const version = expensesStore.monthMutationVersion(monthKey);
	const valid = () => isCurrent() && expensesStore.storeGenerationVersion() === generation;

	return getMonthlyFromCacheFirst(monthKey, {
		onRevalidated: (key, rows) => {
			if (!valid()) {
				return;
			}
			if (expensesStore.monthMutationVersion(key) !== version) {
				Logger.log('Skip merging revalidated month after a local write:', key);
				return;
			}
			expensesStore.mergeMonth(key, rows);
		}
	}).then((rows) => {
		if (valid()) {
			// Keep neighbouring months and rows upserted while this month was loading.
			expensesStore.setMoreItems(rows);
			expensesStore.markMonthLoaded(monthKey);
		}
		return rows;
	});
}

/** Load the month unless a complete snapshot of it is already in the store. */
export async function ensureMonthLoaded(monthKey: string): Promise<void> {
	if (expensesStore.isMonthLoaded(monthKey)) {
		return;
	}
	const pending = pendingMonths.get(monthKey);
	if (pending) {
		await pending;
		return;
	}
	const request = loadMonthIntoStore(monthKey).finally(() => {
		pendingMonths.delete(monthKey);
	});
	pendingMonths.set(monthKey, request);
	await request;
}
