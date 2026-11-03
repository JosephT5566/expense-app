<script lang="ts">
	import Icon from '@iconify/svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import classNames from 'classnames';

	import { items, matchNavTab } from './nav-items';

	const match = $derived(matchNavTab(page.route.id));
</script>

<nav
	aria-label="主要導覽"
	class={classNames(
		'hidden md:block', // Display only on medium and larger screens
		'w-64 p-4 border-r border-black/10'
	)}
>
	<ul class="space-y-2">
		{#each items as it (it.key)}
			<li>
				<a
					class="w-full px-4 py-3 text-sm flex items-center gap-3 rounded-lg text-[var(--c-secondary)]"
					class:selected={(match?.tab ?? 'add') === it.key}
					href={resolve(it.path)}
					aria-current={match?.tab === it.key ? match.current : undefined}
				>
					<Icon icon={it.icon} width="24" height="24" />
					<span>{it.label}</span>
				</a>
			</li>
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
