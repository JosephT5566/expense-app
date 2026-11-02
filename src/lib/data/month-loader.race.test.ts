import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ExpenseRow, PageResult } from '$lib/types/expense';

// Regression tests for PR #68 review findings 1-5. The real monthly cache module runs on an
// in-memory idb-keyval fake, so cache writes and patches behave as in the app. Nothing here
// reaches Supabase or IndexedDB.
const fetcher = vi.hoisted(() => ({
	listExpensesMonthly: vi.fn(),
	listExpenses: vi.fn(),
	toggleSettled: vi.fn(),
	bulkToggleSettled: vi.fn()
}));
vi.mock('$lib/data/expenses.fetcher', () => fetcher);

const idb = vi.hoisted(() => {
	const data = new Map<string, unknown>();
	return {
		data,
		get: vi.fn(async (key: string) => data.get(key)),
		set: vi.fn(async (key: string, value: unknown) => {
			data.set(key, value);
		}),
		keys: vi.fn(async () => [...data.keys()]),
		del: vi.fn(async (key: string) => {
			data.delete(key);
		})
	};
});
vi.mock('idb-keyval', () => idb);
vi.mock('$app/environment', () => ({ browser: true }));

import * as expensesStore from '$lib/stores/expenses.store';
import * as cache from '$lib/cache/monthlyExpense';
import { ensureMonthLoaded, loadMonthIntoStore } from '$lib/data/month-loader';

const NOW = new Date('2026-11-02T06:00:00.000Z');
const ELEVEN_MINUTES = 11 * 60 * 1000;

function row(id: string, ts: string, amount = 100): ExpenseRow {
	return {
		id,
		payer_email: 'me@example.com',
		note: id,
		amount,
		currency: 'TWD',
		ts,
		scope: 'personal',
		shares_json: {},
		category_id: null,
		meta: '',
		created_at: ts,
		updated_at: ts,
		is_settled: false
	};
}

function page(items: ExpenseRow[], nextCursor: string | null = null): PageResult<ExpenseRow> {
	return { items, nextCursor };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function storeRow(id: string) {
	return get(expensesStore.items).find((r) => r.id === id);
}

function storeIds(monthKey: string) {
	const [y, m] = monthKey.split('-').map(Number);
	return expensesStore
		.getMonthExpenses(y, m)
		.map((r) => r.id)
		.sort();
}

async function cacheIds(monthKey: string) {
	const rows = await cache.getExpenseFromCache(monthKey);
	return rows ? rows.map((r) => r.id).sort() : null;
}

/** Seed the cache as if it had been written eleven minutes ago (stale). */
async function seedStaleCache(monthKey: string, rows: ExpenseRow[]) {
	vi.setSystemTime(NOW.getTime() - ELEVEN_MINUTES);
	await cache.setExpenseCache(monthKey, rows);
	vi.setSystemTime(NOW);
}

/** Let pending promise callbacks (fetch resolution, cache writes) run. */
async function settle() {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function withTimeout<T>(promise: Promise<T>, ms = 500) {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
		)
	]);
}

const oct1 = row('oct-1', '2026-10-01T02:00:00.000Z', 100);
const oct2 = row('oct-2', '2026-10-15T04:00:00.000Z', 200);

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	vi.clearAllMocks();
	expensesStore.clearAll();
	for (const key of ['2026-09', '2026-10', '2026-11']) {
		await cache.clearExpenseCacheForMonth(key);
	}
	idb.data.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('finding 1: first load keeps local writes made while it was in flight', () => {
	it('keeps an edit made during the first load instead of the older fetched amount', async () => {
		expensesStore.upsertOne(oct1);
		const fetch = deferred<PageResult<ExpenseRow>>();
		fetcher.listExpensesMonthly.mockReturnValueOnce(fetch.promise);

		const request = ensureMonthLoaded('2026-10');
		await vi.waitFor(() => expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1));
		expensesStore.upsertOne({ ...oct1, amount: 900 });
		fetch.resolve(page([oct1, oct2]));
		await request;
		await settle();

		expect(storeRow('oct-1')?.amount).toBe(900);
		expect(storeIds('2026-10')).toEqual(['oct-1', 'oct-2']);
		const cached = await cache.getExpenseFromCache('2026-10');
		expect(cached?.find((r) => r.id === 'oct-1')?.amount).toBe(900);
	});

	it('does not resurrect a row deleted during the first load', async () => {
		expensesStore.upsertOne(oct2);
		const fetch = deferred<PageResult<ExpenseRow>>();
		fetcher.listExpensesMonthly.mockReturnValueOnce(fetch.promise);

		const request = ensureMonthLoaded('2026-10');
		await vi.waitFor(() => expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1));
		expensesStore.deleteOne('oct-2');
		fetch.resolve(page([oct1, oct2]));
		await request;
		await settle();

		expect(storeIds('2026-10')).toEqual(['oct-1']);
		expect(await cacheIds('2026-10')).toEqual(['oct-1']);
	});
});

describe('finding 2: background revalidation keeps cache and store consistent with local writes', () => {
	it('does not keep a locally deleted row in the cache, so the next load does not bring it back', async () => {
		await seedStaleCache('2026-10', [oct1, oct2]);
		const fetch = deferred<PageResult<ExpenseRow>>();
		fetcher.listExpensesMonthly.mockReturnValueOnce(fetch.promise);

		await loadMonthIntoStore('2026-10');
		expect(storeIds('2026-10')).toEqual(['oct-1', 'oct-2']);
		expensesStore.deleteOne('oct-2');
		await settle();
		fetch.resolve(page([oct1, oct2]));
		await settle();

		expect(storeIds('2026-10')).toEqual(['oct-1']);
		expect(await cacheIds('2026-10')).toEqual(['oct-1']);

		await loadMonthIntoStore('2026-10');
		await settle();
		expect(storeIds('2026-10')).toEqual(['oct-1']);
	});

	it('still merges fresh remote rows when a local write lands during the refresh', async () => {
		await seedStaleCache('2026-10', [oct1]);
		const fetch = deferred<PageResult<ExpenseRow>>();
		fetcher.listExpensesMonthly.mockReturnValueOnce(fetch.promise);

		await loadMonthIntoStore('2026-10');
		const local = row('oct-local', '2026-10-20T02:00:00.000Z', 40);
		expensesStore.upsertOne(local);
		const remote = row('oct-remote', '2026-10-21T02:00:00.000Z', 60);
		fetch.resolve(page([{ ...oct1, amount: 150 }, remote]));
		await settle();

		expect(storeIds('2026-10')).toEqual(['oct-1', 'oct-local', 'oct-remote']);
		expect(storeRow('oct-1')?.amount).toBe(150);
		expect(await cacheIds('2026-10')).toEqual(['oct-1', 'oct-local', 'oct-remote']);
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(true);
	});

	it('leaves the month needing revalidation when the background refresh fails', async () => {
		await seedStaleCache('2026-10', [oct1]);
		fetcher.listExpensesMonthly.mockRejectedValueOnce(new Error('offline'));
		await ensureMonthLoaded('2026-10');
		await settle();
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(false);

		// The cache entry looks fresh again (e.g. patched by a local edit), but the next load
		// must still go to the server.
		await cache.setExpenseCache('2026-10', [oct1]);
		fetcher.listExpensesMonthly.mockResolvedValueOnce(page([oct1, oct2]));
		await ensureMonthLoaded('2026-10');
		await settle();

		expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(2);
		expect(storeIds('2026-10')).toEqual(['oct-1', 'oct-2']);
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(true);
	});
});

describe('finding 3: sign-out isolates in-flight month loads', () => {
	it('lets a new session load the month while the old request never resolves', async () => {
		fetcher.listExpensesMonthly.mockReturnValueOnce(new Promise(() => {}));
		void ensureMonthLoaded('2026-11');
		await vi.waitFor(() => expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1));

		expensesStore.clearAll();
		await cache.clearAllExpensesCache();
		const fresh = row('nov-new', '2026-11-01T02:00:00.000Z', 70);
		fetcher.listExpensesMonthly.mockResolvedValueOnce(page([fresh]));
		await withTimeout(ensureMonthLoaded('2026-11'));

		expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(2);
		expect(storeIds('2026-11')).toEqual(['nov-new']);
		expect(expensesStore.isMonthLoaded('2026-11')).toBe(true);
	});

	it('ignores the old session result in both the store and the cache', async () => {
		const old = deferred<PageResult<ExpenseRow>>();
		fetcher.listExpensesMonthly.mockReturnValueOnce(old.promise);
		void ensureMonthLoaded('2026-11');
		await vi.waitFor(() => expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1));

		expensesStore.clearAll();
		await cache.clearAllExpensesCache();
		const fresh = row('nov-new', '2026-11-01T02:00:00.000Z', 70);
		fetcher.listExpensesMonthly.mockResolvedValueOnce(page([fresh]));
		await withTimeout(ensureMonthLoaded('2026-11'));

		old.resolve(page([row('nov-old', '2026-11-02T02:00:00.000Z', 1)]));
		await settle();

		expect(storeIds('2026-11')).toEqual(['nov-new']);
		expect(await cacheIds('2026-11')).toEqual(['nov-new']);
	});

	it('clears the in-memory cache layer as well as IndexedDB', async () => {
		await cache.setExpenseCache('2026-10', [oct1]);
		await cache.clearAllExpensesCache();

		expect(idb.data.size).toBe(0);
		expect(await cache.getExpenseFromCache('2026-10')).toBeNull();
	});
});

describe('finding 4: a stale hit loaded by one page still ends up fresh for another', () => {
	it('merges the background result after the home page that started it went away', async () => {
		await seedStaleCache('2026-10', [oct1]);
		const fetch = deferred<PageResult<ExpenseRow>>();
		fetcher.listExpensesMonthly.mockReturnValueOnce(fetch.promise);

		// Home loads the month, sees the stale hit, and is destroyed before the refresh returns
		// (its page-local request generation changes; the shared store update must not care).
		await loadMonthIntoStore('2026-10');
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(true);

		fetch.resolve(page([{ ...oct1, amount: 150 }, oct2]));
		await settle();
		// Summary then asks for the same month.
		await ensureMonthLoaded('2026-10');
		await settle();

		expect(storeIds('2026-10')).toEqual(['oct-1', 'oct-2']);
		expect(storeRow('oct-1')?.amount).toBe(150);
	});
});

describe('finding 5: a month larger than one page is never treated as complete', () => {
	const big = Array.from({ length: 501 }, (_, i) =>
		row(
			`oct-${String(i).padStart(3, '0')}`,
			new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(),
			1
		)
	);

	it('does not delete rows missing from the first page and does not mark the month loaded', async () => {
		expensesStore.upsertMany(big);
		await seedStaleCache('2026-10', big);
		fetcher.listExpensesMonthly.mockResolvedValueOnce(page(big.slice(0, 500), 'cursor'));

		await loadMonthIntoStore('2026-10');
		await settle();

		expect(storeIds('2026-10')).toHaveLength(501);
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(false);
	});

	it('refetches an incomplete first-load month on the next request', async () => {
		fetcher.listExpensesMonthly.mockResolvedValue(page(big.slice(0, 500), 'cursor'));

		await ensureMonthLoaded('2026-10');
		await ensureMonthLoaded('2026-10');

		expect(storeIds('2026-10')).toHaveLength(500);
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(false);
		expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(2);
	});
});

describe('month snapshots dedupe rows by id', () => {
	it('keeps one row per id, the last one in the snapshot winning', async () => {
		fetcher.listExpensesMonthly.mockResolvedValueOnce(page([oct1, { ...oct1, amount: 123 }]));

		await ensureMonthLoaded('2026-10');

		expect(get(expensesStore.items).filter((r) => r.id === 'oct-1')).toHaveLength(1);
		expect(storeRow('oct-1')?.amount).toBe(123);
	});
});
