<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import { createEventDispatcher } from 'svelte';
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
	}: {
		hideIcon?: boolean;
		expense: ExpenseRow;
		icon: string | null;
		showEdit: boolean;
		showDate: boolean;
		selectable?: boolean;
		checked?: boolean;
		displayShare?: boolean;
	} = $props();

	const dispatch = createEventDispatcher<{
		edit: ExpenseRow;
		toggle: { id: string; checked: boolean };
	}>();

	function onEdit() {
		dispatch('edit', expense);
	}

	function onToggle(e: Event) {
		// console.log('row toggle', e);
		const target = e.target as HTMLInputElement;
		dispatch('toggle', { id: expense.id, checked: !!target.checked });
	}
</script>

<li class="py-2 flex w-full items-center gap-2">
	{#if !displayShare && selectable}
		<input
			type="checkbox"
			class="checkbox checkbox-sm"
			{checked}
			onchange={onToggle}
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
		<span class="pr-0.5 text-sm font-medium truncate whitespace-pre-wrap text-start">{expense.note}</span>
		<span
			class="text-xs w-[20px] h-[20px] rounded-full leading-[20px] text-center bg-[var(--c-primary)]/50"
		>
			{expense.scope === 'household' ? 'H' : 'P'}
		</span>
	</div>
	<div class="text-right tabular-nums font-semibold">{expense.amount}</div>
	{#if showEdit}
		<button class="ml-2 opacity-60 hover:opacity-100" aria-label="Edit" onclick={onEdit}>
			✏️
		</button>
	{/if}
</li>
