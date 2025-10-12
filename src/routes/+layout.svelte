<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { sessionStore } from '$lib/stores/session.store';
	import { categoriesStore } from '$lib/stores/categories.store';
	import { appSettingStore } from '$lib/stores/appSetting.store';
	import { expensesStore } from '$lib/stores/expenses.store';
	import '$lib/theme.css';
	import Header from '$lib/components/ui/Header.svelte';
	import BottomNav from '$lib/components/ui/BottomNav.svelte';
	import AuthModal from '$lib/components/ui/AuthModal.svelte';
	import { isDev } from '$lib/utils/helpers';
	// import { initAuth } from '$lib/stores/session.store';

	let { children } = $props();

	onMount(() => {
		sessionStore.init();
		categoriesStore.load('expense');
		appSettingStore.load();
		expensesStore.loadThisMonth();

		const unsubExpenseStore = isDev
			? expensesStore.items.subscribe(($items) => {
					console.log('Expenses items changed:', $items);
				})
			: null;

		return () => {
			unsubExpenseStore?.();
		};
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Header />
<main class="p-4 space-y-3">
	{@render children?.()}
</main>
<BottomNav />
<AuthModal />
