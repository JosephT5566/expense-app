<script lang="ts">
	import { sessionStore } from '$lib/stores/session.store';
	import { theme } from '$lib/stores/theme.store';
	import { get } from 'svelte/store';
	const { appName = 'PJ Ledger' } = $props();
	const { user } = sessionStore;

	function cycleTheme() {
		const now = get(theme);
		theme.set(now === 'sunset' ? 'moss' : 'sunset');
	}
</script>

<header
	class="flex items-center justify-between px-4 py-3 sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-white/60"
>
	<div class="flex items-center gap-2">
		<div class="w-8 h-8 rounded-xl" style="background: var(--c-primary);"></div>
		<h1 class="font-semibold tracking-tight">{appName}</h1>
	</div>
	<div class="flex items-center gap-3">
		<button class="text-sm opacity-70" onclick={cycleTheme} aria-label="Switch theme"
			>Theme</button
		>
		{#if $user?.photo_url}
			<img src={$user.photo_url} alt="avatar" class="w-8 h-8 rounded-full object-cover" />
		{:else if $user}
			<div
				class="w-8 h-8 rounded-full grid place-items-center bg-[var(--c-accent)] text-white text-sm"
			>
				{($user.display_name ?? $user.email).slice(0, 1).toUpperCase()}
			</div>
		{:else}
			<div
				class="w-8 h-8 rounded-full grid place-items-center bg-gray-300 text-gray-600 text-sm"
			>
				?
			</div>
		{/if}
	</div>
</header>

<style>
	header {
		border-bottom: 1px solid color-mix(in oklab, var(--c-text) 12%, transparent);
	}
</style>
