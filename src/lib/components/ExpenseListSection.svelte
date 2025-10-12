<script lang="ts">
	import ExpenseItemRow from '$lib/components/ExpenseItemRow.svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import { createEventDispatcher } from 'svelte';

	export let items: ExpenseRow[] = [];
	export let categoryIconMap: Record<string, string> = {};
	export let showEdit: boolean = true;

	const dispatch = createEventDispatcher<{ edit: ExpenseRow }>();
	function onEdit(e: CustomEvent<ExpenseRow>) {
		dispatch('edit', e.detail);
	}
</script>

<ul class="mt-3 divide-y divide-black/5">
	{#each items as e (e.id)}
		<ExpenseItemRow
			expense={e}
			icon={categoryIconMap[e.category_id ?? ''] ?? null}
			{showEdit}
			on:edit={onEdit}
		/>
	{/each}
</ul>
