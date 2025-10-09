<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { sessionStore } from '$lib/stores/session.store';
	import { categoriesStore } from '$lib/stores/categories.store';
	import '$lib/theme.css';
	import Header from '$lib/components/ui/Header.svelte';
	import BottomNav from '$lib/components/ui/BottomNav.svelte';
	import AuthModal from '$lib/components/ui/AuthModal.svelte';
	// import { initAuth } from '$lib/stores/session.store';

	let { children } = $props();

	onMount(() => {
		sessionStore.init();
		categoriesStore.load('expense');
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Header/>
<main class="p-4 space-y-3">
	{@render children?.()}
</main>
<BottomNav />
<AuthModal />
