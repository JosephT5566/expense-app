<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import { getTaiwanDate } from '$lib/utils/dates';

	// export let expense: ExpenseRow;
	// export let icon: string | null = null;
	// export let showEdit: boolean = true;
	let {
		expense,
		icon = null,
		showEdit = true,
		showDate = false,
		hideIcon = false,
		selectable = false,
		checked = false,
		displayShare = false,
		onEdit = undefined as ((expense: ExpenseRow) => void) | undefined,
		onToggle = undefined as ((args: { id: string; checked: boolean }) => void) | undefined,
	}: {
		hideIcon?: boolean;
		expense: ExpenseRow;
		icon: string | null;
		showEdit: boolean;
		showDate: boolean;
		selectable?: boolean;
		checked?: boolean;
		displayShare?: boolean;
		onEdit?: (expense: ExpenseRow) => void;
		onToggle?: (args: { id: string; checked: boolean }) => void;
	} = $props();

	function handleEdit() {
		onEdit?.(expense);
	}

	function handleToggle(e: Event) {
		// console.log('row toggle', e);
		const target = e.target as HTMLInputElement;
		e.stopPropagation();
		onToggle?.({ id: expense.id, checked: !!target.checked });
	}
</script>

<li class="py-2 flex w-full items-center gap-2">
	{#if !displayShare && selectable}
		<input
			type="checkbox"
			class="checkbox checkbox-sm"
			{checked}
			onchange={handleToggle}
			aria-label="Select expense"
		/>
	{/if}

	{#if !hideIcon}
		<div class="w-8 h-8 grid place-items-center rounded-lg bg-[var(--c-bg)]">
			{#if icon}
				<Icon {icon} width={16} height={16} />
			{:else}
				💸
			{/if}
		</div>
	{/if}
	<div class="flex-1 flex items-center min-w-0 gap-2">
		{#if showDate}
			{@const { month, day } = getTaiwanDate(expense.ts)}
			<span>{month}/{day}</span>
		{/if}
		<span class="pr-0.5 text-sm font-medium truncate whitespace-pre-wrap text-start"
			>{expense.note}</span
		>
		<span
			class="text-xs w-[20px] h-[20px] rounded-full leading-[20px] text-center bg-[var(--c-primary)]/50"
		>
			{expense.scope === 'household' ? 'H' : 'P'}
		</span>
	</div>
	<div class="text-right tabular-nums font-semibold">{expense.amount}</div>
	{#if showEdit}
		<button class="p-1 ml-2 text-[var(--c-primary)] hover:opacity-100" aria-label="Edit" onclick={handleEdit}>
			<Icon icon="solar:pen-new-square-bold-duotone" width="20" height="20" />
		</button>
	{/if}
</li>
