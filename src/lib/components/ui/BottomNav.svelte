<script lang="ts">
	import { type Tab } from '$lib/stores/nav.store';
	import Icon from '@iconify/svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	type NavPath = '/' | '/summary' | '/setting';
	let activeTab = $state<Tab>('add');

	const items: { key: Tab; label: string; path?: NavPath; icon: string }[] = [
		{ key: 'add', label: 'Add', path: '/', icon: 'solar:document-add-bold-duotone' },
		{ key: 'summary', label: 'Summary', path: '/summary', icon: 'solar:graph-up-bold-duotone' },
		{ key: 'setting', label: 'Setting', path: '/setting', icon: 'solar:settings-bold-duotone' },
	];

	onMount(() => {
		activeTab = items.find((it) => it.path === page.url.pathname)?.key || 'add';
	});
</script>

<nav class="fixed bottom-0 inset-x-0 safe-bottom bg-white border-t border-black/10 z-20">
	<ul class="grid grid-cols-3">
		{#each items as it (it.key)}
			<li>
				<button
					class="w-full py-3 text-sm flex flex-col items-center gap-1"
					class:selected={activeTab === it.key}
					onclick={() => {
						if (it.path) {
							window.location.href = resolve(it.path);
						}
					}}
				>
					<Icon icon={it.icon} width="24" height="24" />
					<span>{it.label}</span>
				</button>
			</li>
		{/each}
	</ul>
</nav>

<style>
	button.selected {
		color: var(--c-primary);
		font-weight: 600;
	}
	nav {
		background: var(--c-card);
	}
</style>
