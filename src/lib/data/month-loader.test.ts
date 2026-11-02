import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ExpenseRow, ScheduledExpenseRow } from '$lib/types/expense';

// All network and IndexedDB access is mocked; nothing here reaches Supabase.
const fetcher = vi.hoisted(() => ({
	listExpensesMonthly: vi.fn(),
	listExpenses: vi.fn(),
	toggleSettled: vi.fn(),
	bulkToggleSettled: vi.fn()
}));
vi.mock('$lib/data/expenses.fetcher', () => fetcher);

const cache = vi.hoisted(() => {
	const entries = new Map<string, ExpenseRow[]>();
	const stale = new Set<string>();
	return {
		entries,
		stale,
		getExpenseFromCache: vi.fn(async (key: string) => entries.get(key) ?? null),
		setExpenseCache: vi.fn(async (key: string, rows: ExpenseRow[]) => {
			entries.set(key, rows);
			stale.delete(key);
		}),
		isStale: vi.fn((key: string) => stale.has(key)),
		persistExpensePatch: vi.fn(async () => {}),
		persistExpenseDelete: vi.fn(async () => {})
	};
});
vi.mock('$lib/cache/monthlyExpense', () => cache);
vi.mock('$app/environment', () => ({ browser: true }));

const scheduledFetcher = vi.hoisted(() => ({
	confirmScheduledExpense: vi.fn(),
	cancelScheduledExpense: vi.fn(),
	deleteScheduledExpense: vi.fn(),
	upsertScheduledExpense: vi.fn()
}));
vi.mock('$lib/data/scheduled-expenses.fetcher', () => scheduledFetcher);
vi.mock('$lib/data/scheduled-cache-first', () => ({
	getPendingScheduledFromCacheFirst: vi.fn(async () => []),
	revalidatePendingScheduledInBackground: vi.fn(async () => {})
}));
vi.mock('$lib/cache/scheduledExpenses', () => ({
	persistScheduledExpenseDelete: vi.fn(async () => {}),
	persistScheduledExpensePatch: vi.fn(async () => {}),
	clearAllScheduledExpensesCache: vi.fn(async () => {})
}));

import * as expensesStore from '$lib/stores/expenses.store';
import * as scheduledStore from '$lib/stores/scheduled-expenses.store';
import { ensureMonthLoaded, loadMonthIntoStore } from '$lib/data/month-loader';

function row(id: string, ts: string, amount = 100, extra: Partial<ExpenseRow> = {}): ExpenseRow {
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
		is_settled: false,
		...extra
	};
}

function page(items: ExpenseRow[]) {
	return { items, nextCursor: null };
}

function monthTotal(year: number, month: number) {
	return expensesStore.getMonthExpenses(year, month).reduce((sum, e) => sum + e.amount, 0);
}

function idsOf(rows: ExpenseRow[]) {
	return rows.map((r) => r.id).sort();
}

const october = [
	row('oct-1', '2026-10-01T02:00:00.000Z', 100),
	row('oct-2', '2026-10-15T04:00:00.000Z', 200),
	// 2026-10-31 23:30 in Taiwan is still October.
	row('oct-3', '2026-10-31T15:30:00.000Z', 300)
];

beforeEach(() => {
	vi.clearAllMocks();
	cache.entries.clear();
	cache.stale.clear();
	expensesStore.clearAll();
	scheduledStore.clearAll();
});

describe('ensureMonthLoaded', () => {
	it('loads the full month even when the store already holds a single row of it', async () => {
		expensesStore.upsertOne(october[1]);
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(false);
		fetcher.listExpensesMonthly.mockResolvedValue(page(october));

		await ensureMonthLoaded('2026-10');

		expect(fetcher.listExpensesMonthly).toHaveBeenCalledWith('2026-10');
		expect(idsOf(expensesStore.getMonthExpenses(2026, 10))).toEqual([
			'oct-1',
			'oct-2',
			'oct-3'
		]);
		expect(get(expensesStore.items)).toHaveLength(3);
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(true);
	});

	it('does not refetch a month that is already fully loaded', async () => {
		fetcher.listExpensesMonthly.mockResolvedValue(page(october));
		await ensureMonthLoaded('2026-10');
		await ensureMonthLoaded('2026-10');

		expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1);
		expect(cache.getExpenseFromCache).toHaveBeenCalledTimes(1);
	});

	it('shares one in-flight request for concurrent calls', async () => {
		fetcher.listExpensesMonthly.mockResolvedValue(page(october));
		await Promise.all([ensureMonthLoaded('2026-10'), ensureMonthLoaded('2026-10')]);

		expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1);
	});

	it('marks an empty month as loaded', async () => {
		fetcher.listExpensesMonthly.mockResolvedValue(page([]));
		await ensureMonthLoaded('2026-09');
		await ensureMonthLoaded('2026-09');

		expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1);
		expect(expensesStore.isMonthLoaded('2026-09')).toBe(true);
	});

	it('forgets loaded months on clearAll and ignores loads started before it', async () => {
		fetcher.listExpensesMonthly.mockResolvedValue(page(october));
		await ensureMonthLoaded('2026-10');
		expensesStore.clearAll();
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(false);

		let resolveFetch!: (value: ReturnType<typeof page>) => void;
		fetcher.listExpensesMonthly.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFetch = resolve;
			})
		);
		cache.entries.clear();
		const request = ensureMonthLoaded('2026-11');
		await vi.waitFor(() => expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(2));
		expensesStore.clearAll();
		resolveFetch(page([row('nov-1', '2026-11-01T02:00:00.000Z')]));
		await request;

		expect(get(expensesStore.items)).toEqual([]);
		expect(expensesStore.isMonthLoaded('2026-11')).toBe(false);
	});
});

describe('stale cache revalidation', () => {
	it('returns cached rows at once, then replaces the month in the store with fresh rows deduped by id', async () => {
		const cached = [
			row('oct-1', '2026-10-01T02:00:00.000Z', 100),
			row('oct-deleted', '2026-10-02T02:00:00.000Z', 999)
		];
		cache.entries.set('2026-10', cached);
		cache.stale.add('2026-10');
		const september = row('sep-1', '2026-09-20T02:00:00.000Z', 50);
		expensesStore.setMoreItems([september]);

		const fresh = [
			row('oct-1', '2026-10-01T02:00:00.000Z', 150),
			row('oct-2', '2026-10-15T04:00:00.000Z', 200),
			row('oct-3', '2026-10-31T15:30:00.000Z', 300)
		];
		let resolveFetch!: (value: ReturnType<typeof page>) => void;
		fetcher.listExpensesMonthly.mockReturnValue(
			new Promise((resolve) => {
				resolveFetch = resolve;
			})
		);

		await loadMonthIntoStore('2026-10');
		expect(idsOf(expensesStore.getMonthExpenses(2026, 10))).toEqual(['oct-1', 'oct-deleted']);

		resolveFetch(page(fresh));
		await vi.waitFor(() =>
			expect(idsOf(expensesStore.getMonthExpenses(2026, 10))).toEqual([
				'oct-1',
				'oct-2',
				'oct-3'
			])
		);

		const all = get(expensesStore.items);
		expect(idsOf(all)).toEqual(['oct-1', 'oct-2', 'oct-3', 'sep-1']);
		expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
		expect(all.find((r) => r.id === 'oct-1')?.amount).toBe(150);
		expect(monthTotal(2026, 10)).toBe(650);
		expect(cache.setExpenseCache).toHaveBeenCalledWith('2026-10', fresh);
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(true);
	});

	it('keeps a local write made while revalidating instead of applying the older snapshot', async () => {
		cache.entries.set('2026-10', [october[0]]);
		cache.stale.add('2026-10');
		let resolveFetch!: (value: ReturnType<typeof page>) => void;
		fetcher.listExpensesMonthly.mockReturnValue(
			new Promise((resolve) => {
				resolveFetch = resolve;
			})
		);

		await loadMonthIntoStore('2026-10');
		const created = row('oct-new', '2026-10-20T02:00:00.000Z', 40);
		expensesStore.upsertOne(created);
		resolveFetch(page([october[0]]));
		await vi.waitFor(() => expect(cache.setExpenseCache).toHaveBeenCalled());
		await Promise.resolve();

		expect(idsOf(expensesStore.getMonthExpenses(2026, 10))).toEqual(['oct-1', 'oct-new']);
	});

	it('does not revalidate or refetch a fresh cache hit', async () => {
		cache.entries.set('2026-10', october);
		await loadMonthIntoStore('2026-10');

		expect(fetcher.listExpensesMonthly).not.toHaveBeenCalled();
		expect(idsOf(expensesStore.getMonthExpenses(2026, 10))).toEqual([
			'oct-1',
			'oct-2',
			'oct-3'
		]);
	});
});

describe('approving a scheduled expense in a non-current month', () => {
	it('opening that month afterwards totals every expense of the month', async () => {
		// The app started in November: only the current month was loaded.
		fetcher.listExpensesMonthly.mockImplementation(async (key: string) =>
			page(key === '2026-11' ? [row('nov-1', '2026-11-01T02:00:00.000Z', 70)] : october)
		);
		await ensureMonthLoaded('2026-11');
		expect(fetcher.listExpensesMonthly).toHaveBeenCalledTimes(1);

		// Approving an October schedule adds that single expense (ts = scheduled_for).
		const approved = row('oct-approved', '2026-10-25T01:00:00.000Z', 1000);
		const schedule = { id: 'schedule-1', status: 'confirmed' } as ScheduledExpenseRow;
		scheduledFetcher.confirmScheduledExpense.mockResolvedValue({
			expense: approved,
			scheduledExpense: schedule
		});
		await scheduledStore.approve('schedule-1');
		expect(expensesStore.isMonthLoaded('2026-10')).toBe(false);
		expect(monthTotal(2026, 10)).toBe(1000);

		// The server now returns the whole of October, including the approved row.
		fetcher.listExpensesMonthly.mockImplementation(async () => page([...october, approved]));
		await ensureMonthLoaded('2026-10');

		expect(fetcher.listExpensesMonthly).toHaveBeenLastCalledWith('2026-10');
		expect(monthTotal(2026, 10)).toBe(100 + 200 + 300 + 1000);
		expect(get(expensesStore.items).filter((r) => r.id === 'oct-approved')).toHaveLength(1);
		expect(monthTotal(2026, 11)).toBe(70);
	});
});

describe('month range filters with Supabase-formatted ts (#69)', () => {
	const monthStart = row('oct-start', '2026-09-30T16:00:00+00:00', 2700);
	const septLast = row('sep-last', '2026-09-30T15:59:59.999+00:00', 1);
	const novStart = row('nov-start', '2026-10-31T16:00:00+00:00', 5);

	it('getMonthExpenses includes a row exactly at the Taiwan month start', () => {
		expensesStore.upsertMany([monthStart, septLast, novStart]);

		expect(idsOf(expensesStore.getMonthExpenses(2026, 10))).toEqual(['oct-start']);
		expect(idsOf(expensesStore.getMonthExpenses(2026, 9))).toEqual(['sep-last']);
		expect(idsOf(expensesStore.getMonthExpenses(2026, 11))).toEqual(['nov-start']);
	});

	it('markSettledBulk optimistically settles a row exactly at the range start', async () => {
		expensesStore.upsertMany([monthStart, septLast]);
		fetcher.bulkToggleSettled.mockResolvedValue(undefined);

		await expensesStore.markSettledBulk({
			from: '2026-09-30T16:00:00.000Z',
			to: '2026-10-31T15:59:59.999Z',
			next: true
		});

		const settled = Object.fromEntries(
			get(expensesStore.items).map((r) => [r.id, r.is_settled])
		);
		expect(settled).toEqual({ 'oct-start': true, 'sep-last': false });
	});
});
