<script lang="ts">
	import Icon from '@iconify/svelte/dist/OfflineIcon.svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { liquidNav } from './liquid-nav';
	import { items, matchNavTab } from './nav-items';

	type Gesture = {
		id: number;
		route: string | null;
		x: number;
		y: number;
	};

	const threshold = 8;
	const match = $derived(matchNavTab(page.route.id));
	const selectedIndex = $derived(items.findIndex((item) => item.key === (match?.tab ?? 'add')));
	let nav: HTMLElement;
	let track: HTMLUListElement;
	let gesture: Gesture | undefined;
	let dragOffset = $state<number | null>(null);
	let suppressPointerClick = false;

	function start(event: PointerEvent & { currentTarget: HTMLAnchorElement }, selected: boolean) {
		if (gesture || !event.isPrimary || event.button !== 0) {
			return;
		}
		suppressPointerClick = false;
		if (!selected || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		gesture = {
			id: event.pointerId,
			route: page.route.id,
			x: event.clientX,
			y: event.clientY
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	function move(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.id) {
			return;
		}
		const dx = event.clientX - gesture.x;
		const dy = Math.abs(event.clientY - gesture.y);
		if (dragOffset === null) {
			if (dy >= threshold && dy > Math.abs(dx)) {
				gesture = undefined;
				suppressPointerClick = true;
				return;
			}
			if (Math.abs(dx) < threshold) {
				return;
			}
			suppressPointerClick = true;
		}

		const slot = (track.clientWidth - 4) / items.length;
		dragOffset = Math.max(
			-selectedIndex,
			Math.min(items.length - 1 - selectedIndex, dx / slot)
		);
	}

	function finish(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.id) {
			return;
		}
		const { route } = gesture;
		const dragging = dragOffset !== null;
		gesture = undefined;
		dragOffset = null;

		if (event.type !== 'pointerup' || route !== page.route.id) {
			suppressPointerClick = true;
			return;
		}
		const bounds = nav.getBoundingClientRect();
		if (
			event.clientX < bounds.left ||
			event.clientX >= bounds.right ||
			event.clientY < bounds.top ||
			event.clientY >= bounds.bottom
		) {
			suppressPointerClick = true;
			return;
		}
		if (!dragging) {
			return;
		}

		const index = Math.floor(((event.clientX - bounds.left) / bounds.width) * items.length);
		const destination = items[index];
		if (destination && index !== selectedIndex) {
			void goto(resolve(destination.path));
		}
	}

	function preventDragClick(event: MouseEvent) {
		if (suppressPointerClick && event.detail > 0) {
			event.preventDefault();
		}
	}
</script>

<nav
	bind:this={nav}
	aria-label="主要導覽"
	class="glass-nav fixed z-20 md:hidden"
	class:dragging={dragOffset !== null}
	data-liquid-ignore
>
	<div id="mobile-nav-lens" class="lens" aria-hidden="true" use:liquidNav></div>
	<ul
		bind:this={track}
		class="relative z-10 grid h-full grid-cols-4 items-stretch gap-1 rounded-full p-1"
	>
		{#each items as it, index (it.key)}
			{@const selected = selectedIndex === index}
			<li class="min-w-0">
				<a
					class="relative flex h-full min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-center text-xs leading-tight focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
					class:selected
					href={resolve(it.path)}
					aria-current={match?.tab === it.key ? match.current : undefined}
					onpointerdown={(event) => start(event, selected)}
					onpointermove={move}
					onpointerup={finish}
					onpointercancel={finish}
					onlostpointercapture={finish}
					onclickcapture={preventDragClick}
					draggable="false"
				>
					<Icon icon={it.icon} width={22} height={22} aria-hidden="true" />
					<span>{it.label}</span>
				</a>
			</li>
		{/each}
	</ul>
	<div class="pill-track" aria-hidden="true" style:--index={selectedIndex + (dragOffset ?? 0)}>
		<div class="pill"></div>
	</div>
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
		isolation: isolate;
	}

	.lens {
		position: absolute;
		inset: 0;
		z-index: 1;
		border-radius: inherit;
		pointer-events: none;
	}

	.glass-nav:not(:global(.refracting)) .lens,
	.glass-nav:not(:global(.refracting)) > :global(canvas[data-liquid-ignore]) {
		visibility: hidden;
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

	@media not (prefers-reduced-transparency: reduce) {
		.glass-nav:global(.refracting) {
			background: transparent;
			-webkit-backdrop-filter: none;
			backdrop-filter: none;
		}

		.glass-nav:global(.refracting)::before {
			position: absolute;
			inset: 0;
			z-index: 2;
			border-radius: inherit;
			background: color-mix(in srgb, var(--c-card) 52%, transparent);
			-webkit-backdrop-filter: blur(3px);
			backdrop-filter: blur(3px);
			box-shadow: inset 0 1px 1px color-mix(in srgb, white 55%, transparent);
			pointer-events: none;
			content: '';
		}
	}

	.pill-track {
		position: absolute;
		inset: 4px;
		z-index: 3;
		pointer-events: none;
	}

	.pill {
		position: absolute;
		inset-block: 0;
		left: calc(var(--index) * (100% + 4px) / 4);
		width: calc((100% - 12px) / 4);
		border-radius: 999px;
		background: color-mix(in srgb, var(--c-primary) 22%, var(--c-card));
		box-shadow:
			inset 0 1px 1px color-mix(in srgb, white 45%, transparent),
			0 1px 3px rgb(0 0 0 / 12%);
	}

	@media (prefers-reduced-motion: no-preference) {
		.glass-nav:not(.dragging) .pill {
			transition: left 160ms ease-out;
		}
	}

	a {
		color: var(--c-text);
	}

	a.selected {
		font-weight: 650;
		touch-action: pan-y;
		user-select: none;
		cursor: grab;
	}

	.dragging a.selected {
		cursor: grabbing;
	}
</style>
