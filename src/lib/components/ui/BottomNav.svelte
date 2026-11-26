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
	<ul class="grid grid-cols-4 h-12 items-end">
		{#each items as it (it.key)}
			<li>
				<a
					class={classNames(
						'w-full min-h-11 min-w-11 flex items-center justify-center text-[var(--c-muted)]',
						it.key === 'ai-entry' ? 'h-14 -mt-2' : 'h-12'
					)}
					class:selected={(match?.tab ?? 'add') === it.key}
					href={resolve(it.path)}
					aria-label={it.label}
					title={it.label}
					aria-current={match?.tab === it.key ? match.current : undefined}
				>
					<Icon
						icon={it.icon}
						width={it.key === 'ai-entry' ? 32 : 24}
						height={it.key === 'ai-entry' ? 32 : 24}
					/>
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
