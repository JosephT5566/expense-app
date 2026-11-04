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
		'md:hidden', // Display only on small screens
		'fixed bottom-0 inset-x-0 safe-bottom bg-white border-t border-black/10 z-20'
	)}
>
	<ul class="grid grid-cols-3">
		{#each items as it (it.key)}
			<li>
				<a
					class="w-full py-3 text-sm flex flex-col items-center gap-1 text-[var(--c-muted)]"
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
		color: var(--c-primary);
		font-weight: 600;
	}
	nav {
		background: var(--c-card);
	}
</style>
