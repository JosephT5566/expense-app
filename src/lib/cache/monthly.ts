// src/lib/cache/monthly.ts
import { writable, get } from 'svelte/store';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { ExpenseRow } from '$lib/types/expense';

type MonthKey = string; // '2025-10'
type MonthlyData = ExpenseRow[]; // 你的型別
type CacheEntry = { data: MonthlyData; ts: number }; // ts = 快取時間

const mem = writable(new Map<MonthKey, CacheEntry>());
const STALE_MS = 5 * 60 * 1000; // 5 分鐘（可調）

export async function getFromCache(month: MonthKey): Promise<MonthlyData | null> {
	const m = get(mem);
	const hit = m.get(month);
	if (hit) {
		return hit.data;
	}

	const idbHit = (await idbGet<CacheEntry>(`monthly:${month}`)) ?? null;
	if (idbHit) {
		m.set(month, idbHit);
		mem.set(m);
		return idbHit.data;
	}
	return null;
}

export async function setCache(month: MonthKey, data: MonthlyData) {
	const entry = { data, ts: Date.now() };
	const m = get(mem);
	m.set(month, entry);
	mem.set(m);
	await idbSet(`monthly:${month}`, entry);
}

export function isStale(month: MonthKey) {
	const m = get(mem);
	const hit = m.get(month);
	if (!hit) {
		return true;
	}
	return Date.now() - hit.ts > STALE_MS;
}
