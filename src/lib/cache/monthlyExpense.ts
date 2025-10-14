// src/lib/cache/monthly.ts
import { writable, get } from 'svelte/store';
import { get as idbGet, set as idbSet, keys, del } from 'idb-keyval';
import type { ExpenseRow } from '$lib/types/expense';
import { getTaiwanMonthKey } from '$lib/utils/dates';
import { getExpenseCacheKey } from '$lib/utils/cache';
// import { revalidateInBackground } from '$lib/data/monthly-cache-first';

type MonthKey = string; // '2025-10'
type MonthlyData = ExpenseRow[]; // 你的型別
type CacheEntry = { data: MonthlyData; ts: number }; // ts = 快取時間

const mem = writable(new Map<MonthKey, CacheEntry>());
const STALE_MS = 5 * 60 * 1000; // 5 分鐘（可調）

export async function getExpenseFromCache(monthKey: MonthKey): Promise<MonthlyData | null> {
	const m = get(mem);
	const hit = m.get(monthKey);
	if (hit) {
		return hit.data;
	}

	const key = getExpenseCacheKey(monthKey);
	const idbHit = (await idbGet<CacheEntry>(key)) ?? null;
	if (idbHit) {
		m.set(monthKey, idbHit);
		mem.set(m);
		return idbHit.data;
	}
	return null;
}

export async function setExpenseCache(monthKey: MonthKey, data: MonthlyData) {
	const entry = { data, ts: Date.now() };
	const m = get(mem);
	m.set(monthKey, entry);
	mem.set(m);

	const key = getExpenseCacheKey(monthKey);
	await idbSet(key, entry);
}

export function isStale(month: MonthKey) {
	const m = get(mem);
	const hit = m.get(month);
	if (!hit) {
		return true;
	}
	return Date.now() - hit.ts > STALE_MS;
}

export async function clearAllExpensesCache() {
	const all = (await keys()).map(String);

	await Promise.all(all.map((k) => del(k)));
}

// 同月 upsert
async function patchCacheUpsert(monthKey: MonthKey, row: ExpenseRow) {
	const cached = await getExpenseFromCache(monthKey);
	if (!cached) {
		return;
	}

	const items = cached;
	const idx = items.findIndex((x) => x.id === row.id);
	if (idx >= 0) {
		// found existing row
		items[idx] = row;
	} else {
		items.unshift(row); // insert new at the front
	}

	// 寫回（保留 PageResult 其它欄位）
	await setExpenseCache(monthKey, items);
}

// 同月刪除
async function patchCacheRemove(monthKey: MonthKey, id: string) {
	const cached = await getExpenseFromCache(monthKey);
	if (!cached) {
		return;
	}

	const items = cached;
	const next = items.filter((x) => x.id !== id); // remove the existing one

	await setExpenseCache(monthKey, next);
}

export async function persistExpensePatch(oldRow: ExpenseRow | null, newRow: ExpenseRow) {
	const oldMonthKey = oldRow ? getTaiwanMonthKey(oldRow.ts) : null;
	const newMonthKey = getTaiwanMonthKey(newRow.ts);

	// 若跨月，先從舊月移除
	if (oldMonthKey && oldMonthKey !== newMonthKey) {
		await patchCacheRemove(oldMonthKey, newRow.id);
	}
	// 新月 upsert
	await patchCacheUpsert(newMonthKey, newRow);

	// 背景校正（拿 server 回傳的正式資料覆蓋：updated_at、派生欄位…）
	// revalidateInBackground(newMonthKey).catch(() => {});
	// if (oldMonthKey && oldMonthKey !== newMonthKey) {
	// 	revalidateInBackground(oldMonthKey).catch(() => {});
	// }
}
