<script lang="ts">
	import { Sparkles, TreePalm } from 'lucide-svelte';

	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';
	import ScheduledExpenseCard from '$lib/components/ScheduledExpenseCard.svelte';
	import { Button } from '$lib/components/shadcn/button';
	import type { ExpenseRow, ScheduledExpenseRow } from '$lib/types/expense';
	import { taiwanDayBoundsISO } from '$lib/utils/dates';

	let {
		date,
		selectedDate,
		todayDate,
		expenses = [],
		dueScheduledItems = [],
		expensesLoading = false,
		loadError = false,
		onRetry,
		scheduledLoading = false,
		categoryIconMap = {},
		approvingScheduledId = null,
		cancellingScheduledId = null,
		onCreate,
		onEdit,
		onOpenReceiptImport,
		onApproveScheduled,
		onCancelScheduled
	}: {
		date: string;
		selectedDate: string;
		todayDate: string;
		expenses?: ExpenseRow[];
		dueScheduledItems?: ScheduledExpenseRow[];
		expensesLoading?: boolean;
		loadError?: boolean;
		onRetry: () => void;
		scheduledLoading?: boolean;
		categoryIconMap?: Record<string, string>;
		approvingScheduledId?: string | null;
		cancellingScheduledId?: string | null;
		onCreate: () => void;
		onEdit: (expense: ExpenseRow) => void;
		onOpenReceiptImport: () => void;
		onApproveScheduled: (id: string) => void;
		onCancelScheduled: (id: string) => void;
	} = $props();

	const dayBounds = $derived(taiwanDayBoundsISO(date));
	const fromMs = $derived(Date.parse(dayBounds.from));
	const toMs = $derived(Date.parse(dayBounds.to));
	const items = $derived(
		expenses.filter((expense) => {
			const ts = Date.parse(expense.ts);
			return ts >= fromMs && ts <= toMs;
		})
	);
	const scheduledItems = $derived(date === todayDate ? dueScheduledItems : []);
	const isActive = $derived(selectedDate === date);
	const isLoadingEmpty = $derived(
		(expensesLoading || scheduledLoading) &&
			items.length === 0 &&
			scheduledItems.length === 0 &&
			isActive
	);
</script>

<section class="card p-4" data-date={date}>
	{#if loadError}
		<div class="py-12 text-center">
			<p class="mb-3 text-sm">載入支出失敗，請稍後再試。</p>
			<Button variant="outline" onclick={onRetry}>重試</Button>
		</div>
	{:else if isLoadingEmpty}
		<p class="mt-3 opacity-70 text-sm font-medium">載入中…</p>
	{:else}
		{#if scheduledItems.length !== 0}
			<div class="mb-4 space-y-2">
				{#each scheduledItems as row (row.id)}
					<ScheduledExpenseCard
						{row}
						approving={approvingScheduledId === row.id}
						cancelling={cancellingScheduledId === row.id}
						onApprove={onApproveScheduled}
						onCancel={onCancelScheduled}
					/>
				{/each}
			</div>
		{/if}

		{#if items.length !== 0}
			<ExpenseListSection {items} {categoryIconMap} {onEdit} showSum={true} />
		{:else if scheduledItems.length === 0}
			<div class="py-12 flex flex-col items-center justify-center opacity-30">
				<TreePalm class="w-8 h-8 mb-2" />
				<p class="text-xs font-bold uppercase tracking-widest">No Records</p>
			</div>
		{/if}

		<div class="mt-4 flex gap-2">
			<Button class="grow font-bold shadow-sm" onclick={onCreate}>
				{items.length === 0 ? '今日第一筆記帳' : '新增項目'}
			</Button>
			<Button
				class="text-primary hover:bg-primary/5 border-primary/20"
				variant="outline"
				onclick={onOpenReceiptImport}
			>
				<Sparkles class="w-5 h-5" />
			</Button>
		</div>
	{/if}
</section>
