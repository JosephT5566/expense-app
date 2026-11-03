<script lang="ts">
	import { ChartCore, Svg, Spline } from 'layerchart';
	import type { MonthlyBalancePoint } from '$lib/types/monthly-balance';
	import {
		formatBalanceAmount,
		formatBalanceMonth,
		switchMonthLabel
	} from '$lib/utils/monthly-balances';
	let {
		points,
		viewedMonth,
		onSwitch
	}: {
		points: MonthlyBalancePoint[];
		viewedMonth: string;
		onSwitch: (month: string) => Promise<void>;
	} = $props();
	let selected = $state<string | null>(null);
	let switching = $state(false);
	let switchError = $state(false);
	const selectedPoint = $derived(points.find((p) => p.month === selected));
	const data = $derived(points.map((p, i) => ({ ...p, index: i + 0.5 })));
	const max = $derived(Math.max(1, ...points.map((p) => p.amount)));
	const step = $derived(max > 20000 ? 10000 : max > 1000 ? 5000 : 100);
	const top = $derived(Math.ceil(max / step) * step);
	const buttons: HTMLButtonElement[] = [];
	function move(event: KeyboardEvent, index: number) {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
			return;
		}
		event.preventDefault();
		const next = Math.max(
			0,
			Math.min(points.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))
		);
		selected = points[next].month;
		buttons[next]?.focus();
	}
	async function switchMonth() {
		if (!selected || selected === viewedMonth || switching) {
			return;
		}
		switching = true;
		switchError = false;
		try {
			await onSwitch(selected);
		} catch {
			switchError = true;
		} finally {
			switching = false;
		}
	}
	function axisLabel(n: number) {
		return n >= 10000 ? `${n / 10000}萬` : n.toLocaleString('en-US');
	}
</script>

<div role="group" aria-label="近半年開銷折線圖">
	<div class="flex justify-end gap-3 text-xs opacity-70">
		<span class="inline-flex items-center gap-1"
			><i class="h-2 w-2 rounded-full bg-[var(--c-primary)]"></i>檢視中</span
		>
		<span class="inline-flex items-center gap-1"
			><i class="h-2.5 w-2.5 rounded-full border-2 border-[var(--c-accent)]"></i>已選取</span
		>
	</div>
	<div class="relative h-[180px]">
		<ChartCore
			{data}
			x="index"
			y="amount"
			xDomain={[0, 6]}
			yDomain={[0, top]}
			yNice={false}
			padding={{ left: 38, right: 8, top: 40, bottom: 24 }}
			height={180}
		>
			{#snippet children({ context })}
				<Svg aria-hidden="true">
					{#each [0, top / 2, top] as tick (tick)}
						<line
							x1="0"
							x2={context.xScale(6)}
							y1={context.yScale(tick)}
							y2={context.yScale(tick)}
							stroke="var(--c-border)"
							stroke-dasharray={tick === 0 ? undefined : '3 3'}
						/>
						<text
							x="-6"
							y={context.yScale(tick)}
							text-anchor="end"
							dominant-baseline="middle"
							fill="var(--c-text-muted)"
							font-size="10">{axisLabel(tick)}</text
						>
					{/each}
					<Spline stroke="var(--c-primary)" stroke-width={2.5} motion="none" />
					{#each data as point (point.month)}
						{@const x = context.xScale(point.index)}
						{@const y = context.yScale(point.amount)}
						{#if selected === point.month}
							<line
								x1={x}
								x2={x}
								y1={y}
								y2={context.yScale(0)}
								stroke="var(--c-accent)"
								stroke-dasharray="3 3"
							/>
							<circle
								cx={x}
								cy={y}
								r="9.5"
								fill="none"
								stroke="var(--c-accent)"
								stroke-width="2.5"
							/>
						{/if}
						<circle
							cx={x}
							cy={y}
							r={point.month === viewedMonth ? 5.5 : 3.5}
							fill={point.month === viewedMonth
								? 'var(--c-primary)'
								: 'var(--c-card)'}
							stroke="var(--c-primary)"
							stroke-width="2"
						/>
						<text
							{x}
							y={context.yScale(0) + 17}
							text-anchor="middle"
							font-size="11"
							fill={point.month === viewedMonth
								? 'var(--c-primary)'
								: 'var(--c-text-muted)'}>{Number(point.month.split('-')[1])}月</text
						>
						{#if selected === point.month}
							{@const label = formatBalanceAmount(point.amount)}
							{@const width = Math.min(context.xScale(6), label.length * 7.4 + 14)}
							{@const left = Math.max(
								0,
								Math.min(context.xScale(6) - width, x - width / 2)
							)}
							<rect x={left} y={y - 38} {width} height="24" rx="6" fill="#1f2937" />
							<text
								x={left + width / 2}
								y={y - 25}
								dominant-baseline="middle"
								text-anchor="middle"
								fill="white"
								font-size="12"
								font-weight="600">{label}</text
							>
						{/if}
					{/each}
				</Svg>
			{/snippet}
		</ChartCore>
		<div
			class="absolute inset-y-0 right-2 left-[38px] grid grid-cols-6"
			role="group"
			aria-label="選取月份"
		>
			{#each points as point, i (point.month)}
				<button
					bind:this={buttons[i]}
					type="button"
					class="rounded-md hover:bg-black/[0.025] focus-visible:outline-2 focus-visible:outline-[var(--c-accent)]"
					aria-label={`${formatBalanceMonth(point.month)} ${formatBalanceAmount(point.amount)}${point.month === viewedMonth ? '（檢視中）' : ''}`}
					aria-pressed={selected === point.month}
					onclick={() => (selected = point.month)}
					onkeydown={(event) => move(event, i)}
				></button>
			{/each}
		</div>
	</div>
	<p class="sr-only" aria-live="polite">
		{selectedPoint
			? `已選取 ${formatBalanceMonth(selectedPoint.month)}，${formatBalanceAmount(selectedPoint.amount)}`
			: ''}
	</p>
	<button
		class="btn btn-primary mt-2 min-h-11 w-full text-sm"
		disabled={!selected || selected === viewedMonth || switching}
		onclick={switchMonth}
		>{switching ? '切換中…' : switchMonthLabel(selected, viewedMonth)}</button
	>
	{#if switchError}<p role="status" class="mt-2 text-sm">無法載入該月份，請重試</p>{/if}
</div>
