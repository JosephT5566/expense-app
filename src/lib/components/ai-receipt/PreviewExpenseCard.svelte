<script lang="ts">
	import { getTaiwanDate } from '$lib/utils/dates';
	import type { ExpenseRow, PreviewExpense } from '$lib/types/expense';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import PreviewExpenseEditor from './PreviewExpenseEditor.svelte';
	import { Checkbox } from '$lib/components/shadcn/checkbox';

	interface Props {
		previewExpense: PreviewExpense;
		onUpdate?: (updated: PreviewExpense) => void;
		isSelectionMode?: boolean;
		isSelected?: boolean;
		onSelect?: (id: string) => void;
		groupColor?: string;
		isSummary?: boolean;
	}

	let {
		previewExpense = $bindable(),
		onUpdate,
		isSelectionMode = false,
		isSelected = false,
		onSelect,
		groupColor,
		isSummary = false
	}: Props = $props();

	let open = $state(false);
	let isInvalid = $derived.by(() => {
		if (previewExpense.isGrouped && !isSummary) {
			return false;
		}
		return !isCompleteExpense(previewExpense);
	});

	const displayDate = $derived(previewExpense.ts ? getTaiwanDate(previewExpense.ts) : null);
	const displayAmount = $derived(
		typeof previewExpense.amount === 'number' ? previewExpense.amount : null
	);
	const scopeLabel = $derived(
		previewExpense.scope === 'household' ? 'H' : previewExpense.scope === 'personal' ? 'P' : '-'
	);

	function handleCardClick() {
		if (isSelectionMode) {
			if (previewExpense.id) {
				onSelect?.(previewExpense.id);
			}
			return;
		}
		open = true;
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleCardClick();
		}
	}

	function handleOpenChange(newOpen: boolean) {
		open = newOpen;
		if (!newOpen) {
			onUpdate?.(previewExpense);
		}
	}

	function isCompleteExpense(expense: PreviewExpense): expense is ExpenseRow {
		if (!expense.note?.trim()) {
			return false;
		}
		if (
			expense.amount == null ||
			Number.isNaN(Number(expense.amount)) ||
			Number(expense.amount) <= 0
		) {
			return false;
		}
		if (
			!expense.currency ||
			!expense.ts ||
			!expense.scope ||
			!expense.payer_email ||
			!expense.category_id
		) {
			return false;
		}
		if (!expense.shares_json) {
			return false;
		}
		return true;
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<div
		class="relative rounded-xl border p-2 transition-all duration-150 flex items-stretch gap-2"
		class:border-red-500={isInvalid && !isSelectionMode}
		class:border-slate-200={!isInvalid || isSelectionMode}
		class:bg-slate-50={previewExpense.isGrouped || isSummary}
		class:ring-2={isSelected}
		class:ring-primary={isSelected}
		class:cursor-pointer={true}
		style={groupColor
			? isSummary
				? `background-color: ${groupColor}15;`
				: `border-left-width: 4px; border-left-color: ${groupColor}`
			: ''}
		onclick={handleCardClick}
		role="button"
		tabindex={0}
		onkeydown={handleKeyDown}
	>
		{#if isSelectionMode}
			<div class="flex items-center">
				<Checkbox checked={isSelected} />
			</div>
		{/if}

		<div class="flex-1 min-w-0">
			{#if isSummary}
				<div class="grid grid-rows-[auto_1fr_auto] gap-1 py-1 h-full">
					<div class="min-w-0">
						{#if displayDate}
							<span class="text-[10px] opacity-80 block leading-tight"
								>{displayDate.month}/{displayDate.day}</span
							>
						{/if}
						<span class="font-bold text-xs w-full truncate block mt-0.5">
							{previewExpense.note || '合併項目'}
						</span>
					</div>
					<div class="flex-1"></div>
					<div class="tabular-nums text-sm font-bold self-end">
						{displayAmount !== null ? displayAmount.toLocaleString() : '—'}
					</div>
				</div>
			{:else}
				<div class="flex items-center justify-between gap-3 h-full">
					<div class="min-w-0">
						<div class="flex flex-wrap gap-2 text-[10px] text-slate-500">
							{#if displayDate}
								<span>{displayDate.month}/{displayDate.day}</span>
							{/if}
						</div>
						<div class="flex items-center gap-2">
							<span class="truncate font-medium text-sm block"
								>{previewExpense.note || '未命名帳目'}</span
							>
							<span
								class="rounded-full bg-slate-200 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-bold flex-shrink-0"
							>
								{scopeLabel}
							</span>
						</div>
					</div>

					<div class="text-right shrink-0">
						<div class="text-sm font-semibold tabular-nums">
							{displayAmount !== null ? displayAmount.toLocaleString() : '—'}
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-[500px]">
		<Dialog.Header>
			<Dialog.Title>{isSummary ? '合併項目詳情' : '編輯預覽項目'}</Dialog.Title>
		</Dialog.Header>
		<PreviewExpenseEditor bind:previewExpense onClose={() => handleOpenChange(false)} />
	</Dialog.Content>
</Dialog.Root>
