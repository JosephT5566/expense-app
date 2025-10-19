<script lang="ts">
	import ExpenseItemRow from '$lib/components/ExpenseItemRow.svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import classNames from 'classnames';
	import { createEventDispatcher } from 'svelte';

	let {
		items = [],
		categoryIconMap = {},
		showEdit = true,
		sectionClassname,
		hideIcon,
		selectable = false,
		selectedIds = [],
	}: {
		items: ExpenseRow[];
		categoryIconMap: Record<string, string>;
		showEdit?: boolean;
		sectionClassname?: string;
		hideIcon?: boolean;
		selectable?: boolean;
		selectedIds?: string[];
	} = $props();

	const dispatch = createEventDispatcher<{
		edit: ExpenseRow;
		toggle: { id: string; checked: boolean };
	}>();
	function onEdit(e: CustomEvent<ExpenseRow>) {
		dispatch('edit', e.detail);
	}
	function onToggle(e: CustomEvent<{ id: string; checked: boolean }>) {
		dispatch('toggle', e.detail);
	}
</script>

<ul class={classNames('mt-3 divide-y divide-black/5', sectionClassname)}>
	{#each items as e (e.id)}
		<ExpenseItemRow
			expense={e}
			icon={categoryIconMap[e.category_id ?? ''] ?? null}
			{hideIcon}
			{showEdit}
			{selectable}
			checked={selectedIds.includes(e.id)}
			on:edit={onEdit}
			on:toggle={onToggle}
		/>
	{/each}
</ul>
