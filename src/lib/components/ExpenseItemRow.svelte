<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import { createEventDispatcher } from 'svelte';

	export let expense: ExpenseRow;
	export let icon: string | null = null;
	export let showEdit: boolean = true;

	const dispatch = createEventDispatcher<{ edit: ExpenseRow }>();

	function onEdit() {
		dispatch('edit', expense);
	}
</script>

<li class="py-2 flex items-center gap-3">
	<div class="w-8 h-8 grid place-items-center rounded-lg bg-[var(--c-bg)]">
		{#if icon}
			<Icon {icon} width={16} height={16} />
		{:else}
			💸
		{/if}
	</div>
	<div class="flex-1 min-w-0">
		<div class="text-sm font-medium truncate">{expense.note}</div>
		<div class="text-xs opacity-70">{expense.scope === 'household' ? 'h' : 'p'}</div>
	</div>
	<div class="text-right tabular-nums font-semibold">{expense.amount}</div>
	{#if showEdit}
		<button class="ml-2 opacity-60 hover:opacity-100" aria-label="Edit" onclick={onEdit}>
			✏️
		</button>
	{/if}
</li>
