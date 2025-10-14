// src/lib/data/monthly-cache-first.ts
import { getFromCache, setCache, isStale } from '$lib/cache/monthly';
import { listExpensesMonthly } from '$lib/data/expenses.fetcher';

export async function getMonthlyFromCacheFirst(monthKey: string) {
  // 先嘗試命中（記憶體或 IDB），命中就馬上回資料
  const cached = await getFromCache(monthKey);
  if (cached) {
    // 命中但過期 → 背景 revalidate
    if (isStale(monthKey)) {
      revalidateInBackground(monthKey).catch(() => {});
    }
    return cached;
  }

  // 沒命中 → 正式請求
  const fresh = await listExpensesMonthly(monthKey);
  await setCache(monthKey, fresh.items);
  return fresh;
}

async function revalidateInBackground(monthKey: string) {
  const fresh = await listExpensesMonthly(monthKey);
  await setCache(monthKey, fresh.items);
}
