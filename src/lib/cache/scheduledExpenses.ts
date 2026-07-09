import { writable, get } from 'svelte/store';
import { get as idbGet, set as idbSet, keys, del } from 'idb-keyval';
import type { ScheduledExpenseRow } from '$lib/types/expense';
import { SCHEDULED_EXPENSE_CACHE_KEY } from '$lib/utils/cache';

type CacheEntry = { data: ScheduledExpenseRow[]; ts: number };

const mem = writable<CacheEntry | null>(null);
const STALE_MS = 24 * 60 * 60 * 1000;

export async function getScheduledExpensesFromCache(): Promise<ScheduledExpenseRow[] | null> {
	const hit = get(mem);
	if (hit) {
		return hit.data;
	}

	const idbHit = (await idbGet<CacheEntry>(SCHEDULED_EXPENSE_CACHE_KEY)) ?? null;
	if (idbHit) {
		mem.set(idbHit);
		return idbHit.data;
	}

	return null;
}

export async function setScheduledExpensesCache(data: ScheduledExpenseRow[]) {
	const entry = { data, ts: Date.now() };
	mem.set(entry);
	await idbSet(SCHEDULED_EXPENSE_CACHE_KEY, entry);
}

export function isScheduledExpensesCacheStale() {
	const hit = get(mem);
	if (!hit) {
		return true;
	}
	return Date.now() - hit.ts > STALE_MS;
}

export async function clearAllScheduledExpensesCache() {
	const all = (await keys()).map(String).filter((k) => k === SCHEDULED_EXPENSE_CACHE_KEY);
	await Promise.all(all.map((k) => del(k)));
	mem.set(null);
}

export async function persistScheduledExpensePatch(row: ScheduledExpenseRow) {
	const cached = await getScheduledExpensesFromCache();
	if (!cached) {
		return;
	}

	const next = cached.filter((item) => item.id !== row.id);
	if (row.status === 'pending') {
		next.unshift(row);
	}

	await setScheduledExpensesCache(next);
}

export async function persistScheduledExpenseDelete(id: string) {
	const cached = await getScheduledExpensesFromCache();
	if (!cached) {
		return;
	}

	await setScheduledExpensesCache(cached.filter((item) => item.id !== id));
}
