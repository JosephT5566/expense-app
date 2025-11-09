<script lang="ts">
	import { Dialog } from 'bits-ui';
	import SwipeListener from 'swipe-listener';
	import type { SwipeDetail } from 'swipe-listener';
	import { type Snippet } from 'svelte';
	import classNames from 'classnames';

	type Props = {
		open: boolean;
		title?: string;
		maxHeight?: string;
		disableClose?: boolean;
		children?: Snippet;
	};

	let {
		open = $bindable(false),
		title = '',
		maxHeight = '85dvh',
		disableClose = false,
		children,
	}: Props = $props();

	// the sheet element we attach swipe listener to
	let container = $state<HTMLDivElement | null>(null);
	const CLOSE_THRESHOLD = 200;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let dragging = $state(false);
	let dragY = $state(0); // px

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	function getYDirection(event: CustomEvent<SwipeDetail>): 'up' | 'down' | 'none' {
		const y = event.detail.y;
		const diff = Array.isArray(y) ? y[1] - y[0] : y;
		if (diff === 0) {
			return 'none';
		}
		return diff > 0 ? 'up' : 'down';
	}

	$effect(() => {
		if (!container) {
			return;
		}

		const listener = SwipeListener(container, {
			mouse: true,
			preventScroll: true,
			lockAxis: true,
		});

		// while swiping and relate to the animation
		const onSwiping: EventListener = (event) => {
			const e = event as unknown as CustomEvent<SwipeDetail>;
			const [start, end] = e.detail.y;
			const diff = end - start;

			// console.log('swiping', diff);
			if (diff > 0) {
				dragging = true;
				dragY = diff;
			}
		};

		// when swipe ends
		const onSwipe: EventListener = (event) => {
			const e = event as unknown as CustomEvent<SwipeDetail>;
			const [start, end] = e.detail.y;
			const diff = end - start;

			if (!disableClose && diff > CLOSE_THRESHOLD) {
				open = false;
			}
			dragging = false;
			dragY = 0;
		};

		container.addEventListener('swiping', onSwiping);
		container.addEventListener('swipe', onSwipe);

		return () => {
			container?.removeEventListener('swiping', onSwiping);
			container?.removeEventListener('swipe', onSwipe);
			listener.off();
		};
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 bg-black/30" />
		<Dialog.Content
			class={classNames(
				'swipe-drawer-content',
				'absolute bottom-0 inset-x-0 rounded-b-none overflow-auto bg-white rounded-2xl',
				'pb-[var(--nav-height)]',
				'data-[state=open]:animate-enter-from-bottom',
			)}
			style="transform: translateY({dragY}px); height: {maxHeight};"
		>
			<div
				bind:this={container}
				class={classNames(
					'drag-anchor',
					'sticky w-full p-3 top-0 bg-white'
					// 'mx-auto h-1 w-12 rounded-full bg-black/20 mb-2 sticky'
				)}
				aria-hidden="true"
			></div>
			<div class="swipe-drawer-content__container p-4 pt-2 overflow-y-auto">
				{#if title}
					<div class="flex items-center justify-between mb-2">
						<h3 class="font-semibold">{title}</h3>
					</div>
				{/if}
				{@render children?.()}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	.drag-anchor {
		cursor: grab;
	}

	.drag-anchor::after {
		content: '';
		position: absolute;
		background: gray;
		width: 30%;
		height: 4px;
		border-radius: 2px;
		top: 8px;
		left: 50%;
		transform: translateX(-50%);
	}
</style>
