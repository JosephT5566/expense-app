<script lang="ts">
	import Icon from '@iconify/svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	type Tab = 'add' | 'summary' | 'setting';
	type NavPath = '/' | '/summary' | '/setting';
	let activeTab = $state<Tab>('add');

	const items: { key: Tab; label: string; path?: NavPath; icon: string }[] = [
		{ key: 'add', label: '新增', path: '/', icon: 'solar:document-add-bold-duotone' },
		{ key: 'summary', label: '統計', path: '/summary', icon: 'solar:graph-up-bold-duotone' },
		{
			key: 'setting',
			label: '更多功能',
			path: '/setting',
			icon: 'solar:layers-minimalistic-bold-duotone',
		},
	];

	onMount(() => {
		activeTab = items.find((it) => it.path === page.url.pathname)?.key || 'add';
	});
</script>

<nav class="fixed bottom-0 inset-x-0 safe-bottom bg-white border-t border-black/10 z-20">
	<ul class="grid grid-cols-3">
		{#each items as it (it.key)}
			{#if it.path}
				<li>
					<a
						class="w-full py-3 text-sm flex flex-col items-center gap-1 text-[var(--c-muted)]"
						class:selected={activeTab === it.key}
						href={resolve(it.path)}
						target="_self"
					>
						<Icon icon={it.icon} width="24" height="24" />
						<span>{it.label}</span>
					</a>
				</li>
			{/if}
		{/each}
	</ul>
</nav>

<style>
	a.selected {
		color: var(--c-primary);
		font-weight: 600;
	}
	nav {
		background: var(--c-card);
	}
</style>
