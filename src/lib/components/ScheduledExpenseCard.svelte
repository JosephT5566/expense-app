<script lang="ts">
	import { CalendarClock, Check, X } from 'lucide-svelte';

	import { Button } from '$lib/components/shadcn/button';
	import type { ScheduledExpenseRow } from '$lib/types/expense';

	let {
		row,
		approving = false,
		cancelling = false,
		onApprove,
		onCancel
	}: {
		row: ScheduledExpenseRow;
		approving?: boolean;
		cancelling?: boolean;
		onApprove: (id: string) => void;
		onCancel: (id: string) => void;
	} = $props();

	const busy = $derived(approving || cancelling);

	function formatAmount(value: number) {
		return new Intl.NumberFormat('zh-TW', {
			style: 'currency',
			currency: 'TWD',
			maximumFractionDigits: 0
		}).format(value);
	}
</script>

<article class="rounded-lg border border-primary/20 bg-primary/5 p-3">
	<div class="flex items-center justify-between gap-3">
		<div class="min-w-0">
			<div class="flex items-center gap-2">
				<span
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
				>
					<CalendarClock class="h-4 w-4" />
				</span>
				<div class="min-w-0">
					<p class="text-xs text-muted-foreground">預定支出</p>
					<h2 class="truncate font-bold">{row.note}</h2>
				</div>
			</div>
		</div>
		<p class="shrink-0 font-black">{formatAmount(row.amount)}</p>
	</div>
	<div class="mt-3 flex gap-2">
		<Button
			size="sm"
			class="h-8 flex-1 gap-1 text-xs font-bold bg-secondary hover:bg-secondary/20"
			disabled={busy}
			onclick={() => onApprove(row.id)}
		>
			<Check class="h-4 w-4" />
			套用
		</Button>
		<Button
			size="sm"
			variant="outline"
			class="h-8 gap-1 text-xs font-bold"
			disabled={busy}
			onclick={() => onCancel(row.id)}
		>
			<X class="h-4 w-4" />
			取消
		</Button>
	</div>
</article>
