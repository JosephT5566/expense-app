import { beforeEach, describe, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
	get: vi.fn(async (key: string) => disk.get(key)),
	set: vi.fn(async (key: string, value: unknown) => {
		disk.set(key, value);
	}),
	keys: vi.fn(async () => [...disk.keys()]),
	del: vi.fn(async (key: string) => {
		disk.delete(key);
	})
}));
import {
	balanceCacheKey,
	balanceCacheVersion,
	readBalanceCache,
	writeBalanceCache,
	clearMonthlyBalancesCache,
	balanceCacheIsStale
} from './monthlyBalances';

beforeEach(async () => {
	await clearMonthlyBalancesCache();
	vi.useRealTimers();
});
describe('account scoped monthly balance cache', () => {
	it('separates account and month window keys', async () => {
		const key = balanceCacheKey('me@example.test', '2026-06');
		expect(key).not.toBe(balanceCacheKey('other@example.test', '2026-06'));
		expect(key).not.toBe(balanceCacheKey('me@example.test', '2026-07'));
		await writeBalanceCache(key, [], balanceCacheVersion());
		expect((await readBalanceCache(key))?.data).toEqual([]);
		expect(await readBalanceCache(balanceCacheKey('other@example.test', '2026-06'))).toBeNull();
	});
	it('expires after ten minutes and clears disk and memory at sign out or writes', async () => {
		vi.useFakeTimers();
		const key = balanceCacheKey('me@example.test', '2026-06');
		await writeBalanceCache(key, [], balanceCacheVersion());
		const entry = await readBalanceCache(key);
		expect(entry && balanceCacheIsStale(entry)).toBe(false);
		vi.advanceTimersByTime(600000);
		expect(entry && balanceCacheIsStale(entry)).toBe(true);
		await clearMonthlyBalancesCache();
		expect(await readBalanceCache(key)).toBeNull();
		expect(disk.has(key)).toBe(false);
	});
	it('rejects a response from before an invalidation', async () => {
		const version = balanceCacheVersion();
		const key = balanceCacheKey('me@example.test', '2026-06');
		await clearMonthlyBalancesCache();
		await writeBalanceCache(key, [], version);
		expect(await readBalanceCache(key)).toBeNull();
	});
	it('orders clearing after a pending disk write', async () => {
		const key = balanceCacheKey('me@example.test', '2026-06');
		const pending = writeBalanceCache(key, [], balanceCacheVersion());
		const clear = clearMonthlyBalancesCache();
		await Promise.all([pending, clear]);
		expect(await readBalanceCache(key)).toBeNull();
	});
});
