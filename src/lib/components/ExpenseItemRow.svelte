<script lang="ts">
	import Icon from '@iconify/svelte/dist/OfflineIcon.svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import { getTaiwanDate } from '$lib/utils/dates';
	import { user } from '$lib/stores/session.store';

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
		onToggle = undefined as ((args: { id: string; checked: boolean }) => void) | undefined
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
		const target = e.target as HTMLInputElement;
		e.stopPropagation();
		onToggle?.({ id: expense.id, checked: !!target.checked });
	}
</script>

<li class="expense-item-row py-2 flex w-full items-center gap-2">
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
			class="text-xs w-[20px] h-[20px] rounded-full leading-[20px] text-center bg-[var(--c-accent)]/50"
		>
			{expense.scope === 'household' ? 'H' : 'P'}
		</span>
		{#if expense.scope === 'household'}
			<div class="tooltip" data-tip={expense.is_settled ? '已結算' : '未結算'}>
				{#if expense.is_settled}
					<Icon
						icon="ph:check-circle-duotone"
						class="text-emerald-400"
						width="15"
						height="15"
					/>
				{:else}
					<Icon icon="ph:x-circle-duotone" class="text-red-400" width="15" height="15" />
				{/if}
			</div>
		{/if}
	</div>
	<div class="text-right tabular-nums font-semibold">
		{expense.scope === 'personal' ? expense.amount : expense.shares_json[$user?.email ?? '']}
	</div>
	{#if showEdit}
		<button
			class="p-1 ml-2 text-[var(--c-primary)] hover:opacity-100"
			aria-label="Edit"
			onclick={handleEdit}
		>
			<Icon icon="ph:note-pencil-duotone" width="20" height="20" />
		</button>
	{/if}
</li>
