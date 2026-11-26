<script lang="ts">
	import Icon from '@iconify/svelte/dist/OfflineIcon.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { items, matchNavTab } from './nav-items';

	const match = $derived(matchNavTab(page.route.id));
	const activeIndex = $derived(
		Math.max(
			0,
			items.findIndex((item) => item.key === (match?.tab ?? 'add'))
		)
	);
	let pressed = $state<string | null>(null);
</script>

<nav aria-label="主要導覽" class="glass-nav fixed z-20 md:hidden">
	<div
		class="lens"
		style:transform={`translateX(${activeIndex * 100}%)`}
		aria-hidden="true"
	></div>
	<ul class="relative grid h-full grid-cols-4 items-center">
		{#each items as it (it.key)}
			<li>
				<a
					class="flex h-16 min-h-11 min-w-11 w-full items-center justify-center"
					class:selected={(match?.tab ?? 'add') === it.key}
					href={resolve(it.path)}
					aria-label={it.label}
					title={it.label}
					aria-current={match?.tab === it.key ? match.current : undefined}
					onpointerdown={() => {
						pressed = it.key;
					}}
					onanimationend={() => {
						pressed = null;
					}}
				>
					<span class:bounce={pressed === it.key}
						><Icon icon={it.icon} width={28} height={28} /></span
					>
				</a>
			</li>
		{/each}
	</ul>
</nav>

<style>
	.glass-nav {
		left: 16px;
		right: 16px;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 8px);
		height: 64px;
		border-radius: 32px;
		border: 1px solid rgb(255 255 255 / 65%);
		background: linear-gradient(135deg, rgb(255 255 255 / 82%), rgb(255 255 255 / 60%));
		-webkit-backdrop-filter: blur(28px) saturate(190%);
		backdrop-filter: blur(28px) saturate(190%);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 85%),
			0 8px 28px rgb(0 0 0 / 12%);
	}
	a {
		color: #374151;
	}
	a.selected {
		color: var(--c-primary);
	}
	.lens {
		position: absolute;
		top: 6px;
		left: 0;
		width: 25%;
		height: 50px;
		border-radius: 28px;
		background: linear-gradient(rgb(255 255 255 / 85%), rgb(255 255 255 / 35%));
		box-shadow:
			inset 0 1px 1px white,
			0 2px 8px rgb(0 0 0 / 7%);
		transition: transform 480ms cubic-bezier(0.22, 1.35, 0.38, 1);
		pointer-events: none;
	}
	.bounce {
		animation: tap-bounce 260ms ease-out;
	}
	@keyframes tap-bounce {
		0%,
		100% {
			transform: scale(1);
		}
		40% {
			transform: scale(0.84);
		}
		70% {
			transform: scale(1.08);
		}
	}
	@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
		.glass-nav {
			background: var(--c-card);
		}
		a:not(.selected) {
			color: var(--c-text);
		}
	}
	@media (prefers-reduced-transparency: reduce) {
		.glass-nav {
			background: var(--c-card);
			-webkit-backdrop-filter: none;
			backdrop-filter: none;
		}
		a:not(.selected) {
			color: var(--c-text);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.lens {
			transition: none;
		}
		.bounce {
			animation: none;
		}
	}
</style>
