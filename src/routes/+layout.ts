// src/routes/+layout.ts
import type { LayoutLoad } from './$types';
import { getMonthlyFromCacheFirst } from '$lib/data/monthly-cache-first';
import { currentTaiwanMonthKey } from '$lib/utils/dates';

export const load: LayoutLoad = async ({ depends, url }) => {
	const monthKey = url.searchParams.get('m') ?? currentTaiwanMonthKey(); // 例如 2025-10
	const key = `app:monthly-expenses:${monthKey}` as `${string}:${string}`;

	// 告訴 SvelteKit：這段資料的失效由這個 key 控制
	depends(key);

	// 這裡不要直接 hit 網路；先交給快取層
	const data = await getMonthlyFromCacheFirst(monthKey);

	return { month: monthKey, monthlyData: data };
};
