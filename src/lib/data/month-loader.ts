// src/lib/data/month-loader.ts
import { browser } from '$app/environment';
import * as expensesStore from '$lib/stores/expenses.store';
import type { MonthLoadToken, MonthSnapshot } from '$lib/stores/expenses.store';
import { setExpenseCache } from '$lib/cache/monthlyExpense';
import { fetchMonthSnapshot, readMonthFromCache } from '$lib/data/monthly-cache-first';
import Logger from '$lib/utils/logger';

// In-flight `ensureMonthLoaded` requests, keyed by store generation and month so a request
// started before sign-out (`clearAll`) is never shared with the next session.
const pendingMonths = new Map<string, Promise<void>>();

/**
 * Load a Taiwan month ('YYYY-MM') into the expense store, cache first.
 *
 * - Cache hit: its rows are merged into the store (never removing rows) and the month is
 *   marked loaded. A stale hit (older than ten minutes) also starts a background
 *   revalidation that applies the fresh server rows when it finishes, whichever page started
 *   it; only sign-out (a new store generation) discards it.
 * - Cache miss, or a month marked as needing revalidation: the server rows are fetched first.
 *
 * Server rows replace the month in the store (rows absent from the server are removed), except
 * rows upserted or deleted locally while the load was in flight, which keep their local state.
 * The cache is then written from the store's resulting month rows, so it matches the store.
 * Nothing is written to the store or the cache after sign-out. When the server reports more
 * than one page, no rows are removed, nothing is cached, and the month stays unloaded.
 */
export async function loadMonthIntoStore(monthKey: string): Promise<void> {
	const token = expensesStore.beginMonthLoad(monthKey);
	let handedOff = false;
	try {
		if (browser && !expensesStore.monthNeedsRevalidation(monthKey)) {
			const cached = await readMonthFromCache(monthKey);
			if (cached) {
				const applied = expensesStore.applyMonthSnapshot(
					token,
					{ rows: cached.rows, complete: true },
					'merge'
				);
				if (applied && cached.stale) {
					handedOff = true;
					void revalidateInBackground(token);
				}
				return;
			}
		}
		Logger.log(
			'monthly cache miss or revalidation needed, fetch from supabase. key:',
			monthKey
		);
		await applyServerSnapshot(token, await fetchMonthSnapshot(monthKey));
	} finally {
		if (!handedOff) {
			expensesStore.endMonthLoad(token);
		}
	}
}

async function applyServerSnapshot(token: MonthLoadToken, snapshot: MonthSnapshot) {
	const monthRows = expensesStore.applyMonthSnapshot(token, snapshot, 'replace');
	if (browser && monthRows && snapshot.complete) {
		await setExpenseCache(token.monthKey, monthRows);
	}
}

async function revalidateInBackground(token: MonthLoadToken) {
	try {
		await applyServerSnapshot(token, await fetchMonthSnapshot(token.monthKey));
	} catch (error) {
		if (expensesStore.storeGenerationVersion() === token.generation) {
			// Keep showing the cached rows, but fetch from the server on the next load.
			expensesStore.markMonthNeedsRevalidation(token.monthKey);
		}
		Logger.error('Background revalidation failed:', token.monthKey, error);
	} finally {
		expensesStore.endMonthLoad(token);
	}
}

/** Load the month unless a complete snapshot of it is already in the store. */
export async function ensureMonthLoaded(monthKey: string): Promise<void> {
	if (expensesStore.isMonthLoaded(monthKey)) {
		return;
	}
	const key = `${expensesStore.storeGenerationVersion()}:${monthKey}`;
	const pending = pendingMonths.get(key);
	if (pending) {
		await pending;
		return;
	}
	const request = loadMonthIntoStore(monthKey).finally(() => {
		if (pendingMonths.get(key) === request) {
			pendingMonths.delete(key);
		}
	});
	pendingMonths.set(key, request);
	await request;
}
