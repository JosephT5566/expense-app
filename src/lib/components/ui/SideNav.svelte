<script lang="ts">
	import Icon from '@iconify/svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import classNames from 'classnames';

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

<nav
	class={classNames(
		'hidden md:block', // Display only on medium and larger screens
		'w-64 p-4 border-r border-black/10',
	)}
>
	<ul class="space-y-2">
		{#each items as it (it.key)}
			{#if it.path}
				<li>
					<a
						class="w-full px-4 py-3 text-sm flex items-center gap-3 rounded-lg text-[var(--c-secondary)]"
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
		background: var(--c-primary);
		color: var(--c-card);
		font-weight: 600;
	}
</style>
