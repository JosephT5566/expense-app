<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { type LayoutData } from './$types';
	import type { Snippet } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { AppUser } from '$lib/types/user';

	import { setFromLoad as setSessionStore, startAuthListener } from '$lib/stores/session.store';
	import { setFromLoad as setCategoriesStore } from '$lib/stores/categories.store';
	import { setFromLoad as setAppSettingStore } from '$lib/stores/appSetting.store';
	import * as expensesStore from '$lib/stores/expenses.store';
	import { setMonthlyItemsFromLoad, items as expenseItems } from '$lib/stores/expenses.store';
	import '$lib/theme.css';
	import Header from '$lib/components/ui/Header.svelte';
	import BottomNav from '$lib/components/ui/BottomNav.svelte';
	import AuthModal from '$lib/components/ui/AuthModal.svelte';
	import { isDev } from '$lib/utils/helpers';
	import { clearAllExpensesCache } from '$lib/cache/monthlyExpense';
	import Logger from '$lib/utils/logger';

	let {
		data,
		children,
	}: {
		children: Snippet;
		data: LayoutData;
	} = $props();
	const { user, categories, allowedEmails, monthlyData } = data ?? {};

	// 1) 直接 set，不要在 component 內再發請求
	setSessionStore(user as AppUser | null);
	if (categories) {
		setCategoriesStore(categories);
	}
	if (allowedEmails) {
		setAppSettingStore(allowedEmails);
	}
	if (monthlyData) {
		setMonthlyItemsFromLoad(monthlyData);
	}

	onMount(() => {
		const unsubExpenseStore = isDev
			? expenseItems.subscribe(($items) => {
					Logger.log('Expenses items changed:', $items);
				})
			: null;

		const unsubAuthListener = startAuthListener({
			onLogout: async () => {
				Logger.log('🚀 User logged out');
				expensesStore.clearAll();
				clearAllExpensesCache();
				goto(resolve('/')); // redirect to home
			},
			onLogin: async () => {
				// trigger load in the layout.ts to refetch data
				await invalidateAll();
			},
		});

		return () => {
			unsubExpenseStore?.();
			unsubAuthListener?.();
		};
	});
</script>

<svelte:head>
	<title>Welcome to PJ's Ledger</title>
</svelte:head>

<Header />
<main class="p-4 space-y-3 h-[calc(100dvh-var(--nav-height))] pb-[var(--nav-height)] overflow-auto">
	{@render children?.()}
</main>
<BottomNav />
<AuthModal />
