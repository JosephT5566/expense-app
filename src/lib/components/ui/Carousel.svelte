<script lang="ts">
	import { onMount, createEventDispatcher } from 'svelte';
	import type { Snippet } from 'svelte';
	import SwipeListener from 'swipe-listener';
	import classNames from 'classnames';

	type Item = unknown;

	// props（runes）
	const {
		items = [] as Item[],
		/** 幾張卡同時顯示（可被 breakpoints 覆寫） */
		slidesPerView = 1,
		/** 卡片間距（px；可被 breakpoints 覆寫） */
		gap = 16,
		/** 初始頁索引（基於「頁」而非單卡） */
		initialIndex = 0,
		/** 是否循環 */
		loop = true,
		/** 自動播放（毫秒；0=關閉） */
		autoplayMs = 0,
		/** 是否顯示圓點 */
		showDots = true,
		/** 是否顯示左右箭頭 */
		showArrows = true,
		/** 無障礙：每張卡 aria-label 前綴 */
		itemLabel = 'Slide',
		carouselSlideClassName = '',
		/** 斷點：{ [minWidth]: { slidesPerView?, gap? } } */
		breakpoints = undefined as
			| Record<number, { slidesPerView?: number; gap?: number }>
			| undefined,
		/** 滑過時暫停自動播放 */
		pauseOnHover = true,
		/** 聚焦於輪播時暫停自動播放 */
		pauseOnFocus = true,
		/** 預設 children snippet：{#snippet children(pageItem, i)}...{/snippet} */
		children = undefined as Snippet<[Item, number]> | undefined,
	} = $props();

	const dispatch = createEventDispatcher<{ change: { index: number } }>();

	// state（runes）
	let viewport: HTMLDivElement;
	let sliding = $state(false);
	// 先用傳入的 initialIndex，後續在 mount / 尺寸變動時校正到合法頁面範圍
	let index = $state(Math.max(0, initialIndex));
	let isPointerDown = false;
	let isUserPaused = false; // hover / focus 暫停
	let viewportWidth = $state(0);
	let prefersReducedMotion = false;

	// 衍生值
	const itemCount = $derived(items.length);

	function computeEffectiveSlidesPerView() {
		let spv = Math.max(1, slidesPerView);
		if (breakpoints && viewportWidth) {
			const sorted = Object.keys(breakpoints)
				.map(Number)
				.sort((a, b) => a - b);
			for (const bp of sorted) {
				if (viewportWidth >= bp) {
					const cfg = breakpoints[bp];
					if (cfg.slidesPerView != null) {
						spv = Math.max(1, cfg.slidesPerView);
					}
				}
			}
		}
		return spv;
	}
	function computeEffectiveGap() {
		let g = Math.max(0, gap);
		if (breakpoints && viewportWidth) {
			const sorted = Object.keys(breakpoints)
				.map(Number)
				.sort((a, b) => a - b);
			for (const bp of sorted) {
				if (viewportWidth >= bp) {
					const cfg = breakpoints[bp];
					if (cfg.gap != null) {
						g = Math.max(0, cfg.gap);
					}
				}
			}
		}
		return g;
	}

	const effectiveSlidesPerView = $derived(computeEffectiveSlidesPerView());
	const effectiveGap = $derived(computeEffectiveGap());

	// 頁數（以「一個 viewport 寬」為單位）
	const pageCount = $derived(
		Math.max(1, Math.ceil(Math.max(0, itemCount) / Math.max(1, effectiveSlidesPerView)))
	);
	const canPrev = $derived(loop || index > 0);
	const canNext = $derived(loop || index < Math.max(0, pageCount - 1));

	function pageWidth() {
		// 捲動一步 = 一個 viewport 寬
		return viewport?.clientWidth ?? 0;
	}

	function goTo(i: number, behavior: ScrollBehavior = 'smooth') {
		if (!viewport || pageCount === 0) {
			return;
		}

		let target = i;
		if (loop) {
			// 循環
			if (i < 0) {
				target = pageCount - 1;
			}
			if (i > pageCount - 1) {
				target = 0;
			}
		} else {
			target = Math.max(0, Math.min(i, pageCount - 1));
		}

		index = target;
		sliding = true;
		const preferBehavior: ScrollBehavior = prefersReducedMotion ? 'auto' : behavior;
		viewport.scrollTo({ left: target * pageWidth(), behavior: preferBehavior });
		// 向外拋出改變事件
		dispatch('change', { index });
	}

	function next(step = 1) {
		if (!canNext && !loop) {
			return;
		}
		goTo(index + step);
	}

	function prev(step = 1) {
		if (!canPrev && !loop) {
			return;
		}
		goTo(index - step);
	}

	// 匯出控制方法（父層可透過 bind:this 呼叫）
	export { next, prev, goTo };

	// 依捲動量同步 index（支援拖曳/鍵盤導航）
	function handleScroll() {
		if (!viewport) {
			return;
		}
		const w = pageWidth();
		if (w <= 0) {
			return;
		}
		const raw = viewport.scrollLeft / w;
		// 只在非程序性滑動時更新（避免圓點抖動）
		if (!sliding) {
			index = Math.round(raw);
		}
	}

	// 結束 programmatic 動畫後解除鎖
	let scrollStopTimer: ReturnType<typeof setTimeout> | null = null;
	function onAnyScroll() {
		if (scrollStopTimer) {
			clearTimeout(scrollStopTimer);
		}
		scrollStopTimer = setTimeout(() => {
			sliding = false;
		}, 160);
	}

	// swipe-listener 手勢 + 尺寸/偏好監聽
	onMount(() => {
		if (!viewport) {
			return;
		}

		// Reduced motion
		const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
		const updatePRM = () => (prefersReducedMotion = mql.matches);
		updatePRM();
		mql.addEventListener('change', updatePRM);

		// 綁在 viewport，左右滑動翻頁
		SwipeListener(viewport);
		const handler = (e: Event) => {
			const dir = (e as CustomEvent<{ directions?: { left?: boolean; right?: boolean } }>)
				.detail?.directions;
			if (!dir) {
				return;
			}
			if (dir.left) {
				next();
			} else if (dir.right) {
				prev();
			}
		};
		viewport.addEventListener('swipe', handler);

		// 鍵盤：左右鍵
		const keyHandler = (e: KeyboardEvent) => {
			if (e.key === 'ArrowRight') {
				next();
			} else if (e.key === 'ArrowLeft') {
				prev();
			}
		};
		viewport.addEventListener('keydown', keyHandler);

		// 監聽尺寸變動，更新 viewportWidth 並校正定位
		const ro = new ResizeObserver((entries) => {
			const cr = entries[0]?.contentRect;
			if (!cr) {
				return;
			}
			viewportWidth = cr.width;
			// 尺寸改變後維持同一頁
			queueMicrotask(() => {
				// 校正頁索引合法範圍
				index = Math.max(0, Math.min(index, pageCount - 1));
				goTo(index, 'auto');
			});
		});
		ro.observe(viewport);

		// 初始定位（等待 layout 完成）
		queueMicrotask(() => {
			viewportWidth = viewport.clientWidth;
			index = Math.max(0, Math.min(index, pageCount - 1));
			goTo(index, 'auto');
		});

		return () => {
			viewport?.removeEventListener('swipe', handler);
			viewport?.removeEventListener('keydown', keyHandler);
			ro.disconnect();
			mql.removeEventListener('change', updatePRM);
		};
	});

	// 自動播放
	$effect(() => {
		if (!autoplayMs || autoplayMs <= 0 || pageCount <= 1) {
			return;
		}
		let id: ReturnType<typeof setInterval> | null = null;
		const tick = () => {
			if (!isPointerDown && !isUserPaused && !document.hidden) {
				next();
			}
		};
		id = setInterval(tick, autoplayMs);
		return () => clearInterval(id!);
	});

	// 滑鼠/觸控：使用者操作時暫停自動播放
	function setPointer(active: boolean) {
		isPointerDown = active;
	}
	function setUserPaused(active: boolean) {
		isUserPaused = active;
	}
</script>

<!-- 外層：可聚焦（鍵盤左右鍵） -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={viewport}
	tabindex="0"
	class="carousel-viewport"
	onscroll={handleScroll}
	onwheel={onAnyScroll}
	onpointerdown={() => setPointer(true)}
	onpointerup={() => setPointer(false)}
	onpointercancel={() => setPointer(false)}
	onmouseenter={() => pauseOnHover && setUserPaused(true)}
	onmouseleave={() => pauseOnHover && setUserPaused(false)}
	onfocusin={() => pauseOnFocus && setUserPaused(true)}
	onfocusout={() => pauseOnFocus && setUserPaused(false)}
	style={`--gap:${effectiveGap}px; --slides:${effectiveSlidesPerView};`}
	role="region"
	aria-roledescription="carousel"
	aria-label="Carousel"
>
	<div class="carousel-track">
		{#each items as item, i (i)}
			<div
				class={classNames('carousel-slide', carouselSlideClassName)}
				role="group"
				aria-roledescription="slide"
				aria-label={`${itemLabel} ${i + 1} of ${itemCount}`}
			>
				<!-- Svelte 5 children snippet render -->
				{@render children?.(item, i)}
			</div>
		{/each}
	</div>
	<!-- 螢幕閱讀器：公告目前頁次 -->
	<div class="sr-only" aria-live="polite">{`Slide ${index + 1} of ${pageCount}`}</div>
</div>

{#if showArrows && pageCount > 1}
	<div class="carousel-arrows">
		<button
			class="arrow-btn"
			disabled={!canPrev && !loop}
			onclick={() => prev()}
			aria-label="Previous slide"
		>
			◀
		</button>
		<button
			class="arrow-btn"
			disabled={!canNext && !loop}
			onclick={() => next()}
			aria-label="Next slide"
		>
			▶
		</button>
	</div>
{/if}

{#if showDots && pageCount > 1}
	<div class="carousel-dots" role="tablist" aria-label="Carousel Pagination">
		{#each [...Array(pageCount).keys()] as i (i)}
			<button
				role="tab"
				aria-selected={i === index}
				class="dot {i === index ? 'is-active' : ''}"
				onclick={() => goTo(i)}
				aria-label={`Go to slide ${i + 1}`}
			></button>
		{/each}
	</div>
{/if}

<style>
	.carousel-viewport {
		position: relative;
		width: 100%;
		overflow-x: auto;
		overflow-y: hidden;
		scroll-snap-type: x mandatory;
		scrollbar-width: none; /* Firefox */
		-ms-overflow-style: none; /* IE 10+ */
		outline: none;
	}
	.carousel-viewport::-webkit-scrollbar {
		display: none;
	}

	.carousel-track {
		display: flex;
		gap: var(--gap);
		padding: 0; /* 可依需求加左右內距 */
	}

	.carousel-slide {
		flex: 0 0 calc((100% - (var(--gap) * (var(--slides) - 1))) / var(--slides));
		scroll-snap-align: start; /* 以頁面起點對齊，利於一次翻一整頁 */
	}

	.carousel-arrows {
		margin-top: 8px;
		display: flex;
		gap: 8px;
		justify-content: center;
		align-items: center;
	}

	.arrow-btn {
		appearance: none;
		border: 1px solid currentColor;
		background: transparent;
		padding: 4px 8px;
		border-radius: 6px;
		cursor: pointer;
	}
	.arrow-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.carousel-dots {
		margin-top: 8px;
		display: flex;
		gap: 8px;
		justify-content: center;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		opacity: 0.4;
		border: none;
		background: currentColor;
		cursor: pointer;
	}
	.dot.is-active {
		opacity: 1;
		transform: scale(1.25);
	}

	/* 視覺上隱藏但輔助技術可讀 */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
