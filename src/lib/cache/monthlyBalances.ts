import { get as idbGet, set as idbSet, keys, del } from 'idb-keyval';
import { writable } from 'svelte/store';
import type { MonthlyMemberBalance } from '$lib/types/monthly-balance';

const PREFIX = 'monthly-balances:';
const STALE_MS = 10 * 60 * 1000;
type Entry = { data: MonthlyMemberBalance[]; ts: number };
const memory = new Map<string, Entry>();
export const balanceRevision = writable(0);
let revision = 0;
let cleanup = Promise.resolve();

export function balanceCacheKey(email: string, startMonth: string): string {
	return `${PREFIX}${encodeURIComponent(email)}:${startMonth}`;
}
export function balanceCacheVersion(): number {
	return revision;
}

export async function readBalanceCache(key: string): Promise<Entry | null> {
	const version = revision;
	await cleanup;
	let entry = memory.get(key);
	if (!entry) {
		try {
			entry = await idbGet<Entry>(key);
		} catch {
			/* Memory-only when storage is unavailable. */
		}
	}
	if (version !== revision) {
		return null;
	}
	if (entry) {
		memory.set(key, entry);
	}
	return entry ?? null;
}
export function balanceCacheIsStale(entry: Entry): boolean {
	return Date.now() - entry.ts >= STALE_MS;
}

export async function writeBalanceCache(
	key: string,
	data: MonthlyMemberBalance[],
	version: number
) {
	await cleanup;
	if (version !== revision) {
		return;
	}
	const entry = { data, ts: Date.now() };
	memory.set(key, entry);
	try {
		await idbSet(key, entry);
	} catch {
		/* Retain this session's memory cache. */
	}
}

/** Invalidates all account windows, including pending reads. Also used at sign-out. */
export function clearMonthlyBalancesCache() {
	revision += 1;
	memory.clear();
	cleanup = cleanup.then(async () => {
		try {
			const all = (await keys()).filter((k) => String(k).startsWith(PREFIX));
			await Promise.all(all.map((k) => del(k)));
		} catch {
			/* Storage may be disabled; memory is already cleared. */
		}
	});
	balanceRevision.set(revision);
	return cleanup;
}
