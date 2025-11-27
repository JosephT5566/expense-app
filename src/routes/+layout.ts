// src/routes/+layout.ts
import { supabase } from '$lib/supabase/supabaseClient';
import type { LayoutLoad } from './$types';
import { browser } from '$app/environment';

import { listCategories } from '$lib/data/categories.fetcher';
import { listAppSetting } from '$lib/data/appSetting.fetcher';
import { getTaiwanMonthKey } from '$lib/utils/dates';
import { LOAD_DEP_KEYS } from '$lib/utils/const';
import { signOutIfExpired } from '$lib/supabase/auth';
import Logger from '$lib/utils/logger';

export const load: LayoutLoad = async ({ depends, url }) => {
	if (!browser) {
		// ssr 下不處理
		return {};
	}

	const monthKey = url.searchParams.get('m') ?? getTaiwanMonthKey(); // 2025-10

	depends(LOAD_DEP_KEYS.session);
	depends(LOAD_DEP_KEYS.categories);
	depends(LOAD_DEP_KEYS.appSettings);
	depends(LOAD_DEP_KEYS.expenses);

	await signOutIfExpired();

	// 1) 取登入使用者（在 ssr=false 下可安全呼叫）
	const { data: u } = await supabase.auth.getUser();
	const user = u?.user
		? {
				id: u.user.id,
				email: u.user.email ?? '',
				display_name: u.user.user_metadata?.name ?? null,
				photo_url: u.user.user_metadata?.avatar_url ?? null,
			}
		: null;

	Logger.log('layout load user', user);

	if (!user) {
		// is signed out, skip other data fetch
		return {};
	}

	// 2) 取分類（expense）
	const categories = await listCategories({ kind: 'expense' });

	// 3) 取 app 設定
	const appSettings = await listAppSetting();
	const allowedEmails: string[] = appSettings?.[0]?.allowed_emails ?? [];

	return {
		month: monthKey,
		user,
		categories,
		allowedEmails,
		depKeys: LOAD_DEP_KEYS, // 給子層寫入後好用 invalidate(depKeys.xxx)
	};
};
