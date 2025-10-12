<script module lang="ts">
	export type PieDatum = { label: string; value: number; color?: string };
</script>

<script lang="ts">
	const {
		data = [],
		size = 200,
		thickness = 24,
		showLegend = true,
	} = $props<{
		data?: import('./PieChart.svelte').PieDatum[];
		size?: number;
		thickness?: number;
		showLegend?: boolean;
	}>();

	const total = $derived(
		(data as Array<{ value: number }>).reduce(
			(a: number, d: { value: number }) => a + d.value,
			0
		)
	);

	const cx = $derived(size / 2);
	const cy = $derived(size / 2);
	const rOuter = $derived(size / 2 - 2);
	const rInner = $derived(rOuter - thickness);
	const rMid = $derived((rOuter + rInner) / 2);

	function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
		const rad = ((angle - 90) * Math.PI) / 180.0;
		return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
	}
	function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
		const start = polarToCartesian(cx, cy, r, endAngle);
		const end = polarToCartesian(cx, cy, r, startAngle);
		const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
		return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
	}

	function fallbackColor(i: number) {
		const hue = (i * 47) % 360;
		return `hsl(${hue}, 70%, 55%)`;
	}

	type Segment = { start: number; end: number; label: string; value: number; color: string };
	function computeSegments(
		ds: { label: string; value: number; color?: string }[],
		tot: number
	): Segment[] {
		let start = 0;
		const segs: Segment[] = [];
		for (let i = 0; i < ds.length; i++) {
			const d = ds[i];
			if (d.value <= 0) {
				continue;
			}
			const sweep = tot > 0 ? (d.value / tot) * 360 : 0;
			const seg: Segment = {
				start,
				end: start + sweep,
				label: d.label,
				value: d.value,
				color: d.color ?? fallbackColor(i),
			};
			start += sweep;
			segs.push(seg);
		}
		return segs;
	}
	const segments: Segment[] = $derived(computeSegments(data, total));
</script>

{#if total <= 0}
	<div class="text-sm opacity-60">無資料</div>
{:else}
	<div class="flex flex-col items-center">
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
			{#each segments as seg (seg.label)}
				<path
					d={arcPath(cx, cy, rMid, seg.start, seg.end)}
					stroke={seg.color}
					stroke-width={thickness}
					stroke-linecap="butt"
					fill="none"
				/>
			{/each}
			<!-- hole -->
			<circle {cx} {cy} r={rInner} fill="white" />
			<!-- center label -->
			<text
				x={cx}
				y={cy}
				text-anchor="middle"
				dominant-baseline="middle"
				class="font-semibold tabular-nums"
			>
				{total}
			</text>
		</svg>

		{#if showLegend}
			<div class="mt-3 grid grid-cols-2 gap-2 w-full text-sm">
				{#each segments as seg (seg.label)}
					<div class="flex items-center gap-2">
						<span class="inline-block w-3 h-3 rounded" style={`background:${seg.color}`}
						></span>
						<span class="truncate flex-1">{seg.label}</span>
						<span class="tabular-nums">{seg.value}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	text {
		fill: currentColor;
	}
</style>
