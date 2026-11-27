<script lang="ts">
	import Icon from '@iconify/svelte/dist/OfflineIcon.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { items, matchNavTab } from './nav-items';

	const match = $derived(matchNavTab(page.route.id));
</script>

<nav aria-label="主要導覽" class="glass-nav fixed z-20 md:hidden">
	<ul class="grid h-full grid-cols-4 items-stretch gap-1 rounded-full p-1">
		{#each items as it (it.key)}
			<li class="min-w-0">
				<a
					class="flex h-full min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-center text-xs leading-tight focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
					class:selected={(match?.tab ?? 'add') === it.key}
					href={resolve(it.path)}
					aria-current={match?.tab === it.key ? match.current : undefined}
				>
					<Icon icon={it.icon} width={22} height={22} aria-hidden="true" />
					<span>{it.label}</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>

<style>
	.glass-nav {
		inset-inline: 14px;
		bottom: calc(var(--safe-bottom) + 8px);
		height: 64px;
		border: 1px solid color-mix(in srgb, var(--c-text) 12%, var(--c-card));
		border-radius: 32px;
		background: var(--c-card);
		box-shadow: 0 3px 12px rgb(0 0 0 / 8%);
	}

	@supports ((backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px))) {
		@media not (prefers-reduced-transparency: reduce) {
			.glass-nav {
				background: color-mix(in srgb, var(--c-card) 86%, transparent);
				-webkit-backdrop-filter: blur(12px);
				backdrop-filter: blur(12px);
			}
		}
	}

	a {
		color: var(--c-text);
	}

	a.selected {
		background: color-mix(in srgb, var(--c-primary) 22%, var(--c-card));
		font-weight: 650;
	}
</style>
