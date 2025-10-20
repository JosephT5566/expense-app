<script lang="ts">
	import ExpenseItemRow from '$lib/components/ExpenseItemRow.svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import classNames from 'classnames';
	import { createEventDispatcher } from 'svelte';
	import { Accordion } from 'bits-ui';
	import { allowedUserInfo } from '$lib/stores/appSetting.store';

	let {
		items = [],
		categoryIconMap = {},
		showEdit = true,
		sectionClassname,
		hideIcon,
		selectable = false,
		selectedIds = [],
		displayShare = false,
	}: {
		items: ExpenseRow[];
		categoryIconMap: Record<string, string>;
		showEdit?: boolean;
		sectionClassname?: string;
		hideIcon?: boolean;
		selectable?: boolean;
		selectedIds?: string[];
		displayShare?: boolean;
	} = $props();

	const dispatch = createEventDispatcher<{
		edit: ExpenseRow;
		toggle: { id: string; checked: boolean };
	}>();
	function onEdit(e: CustomEvent<ExpenseRow>) {
		dispatch('edit', e.detail);
	}
	function onToggle(e: CustomEvent<{ id: string; checked: boolean }>) {
		e.stopPropagation();
		dispatch('toggle', e.detail);
	}
	const handleCheckboxClicked = (id: string, checked: boolean) => {
		console.log('checkbox clicked');
		dispatch('toggle', { id, checked });
	};
</script>

<ul class={classNames('mt-3 divide-y divide-black/5', sectionClassname)}>
	{#if displayShare}
		<Accordion.Root type="multiple">
			{#each items as e (e.id)}
				{@const payerInfo = $allowedUserInfo[e.payer_email]}
				{@const checked = selectedIds.includes(e.id)}
				<Accordion.Item value={e.id} class="group">
					<Accordion.Header class="flex items-center gap-3">
						{#if selectable}
							<input
								type="checkbox"
								class="checkbox checkbox-sm"
								{checked}
								onchange={(t: Event) => {
									console.log(t);
									const target = t.target as HTMLInputElement;
									handleCheckboxClicked(e.id, !!target.checked);
								}}
								aria-label="Select expense"
							/>
						{/if}
						<Accordion.Trigger
							class="w-full flex items-center justify-between gap-3 transition-all"
						>
							<ExpenseItemRow
								expense={e}
								icon={categoryIconMap[e.category_id ?? ''] ?? null}
								{hideIcon}
								{showEdit}
								{selectable}
								{displayShare}
								checked={selectedIds.includes(e.id)}
								on:edit={onEdit}
								on:toggle={onToggle}
							/>
						</Accordion.Trigger>
					</Accordion.Header>
					<Accordion.Content
						class="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm tracking-[-0.01em]"
					>
						<div class="py-2">
							<span
								class="p-2 rounded-xl"
								style={`background: #${payerInfo.color || 'transparent'}`}
								>{payerInfo.name}</span
							>
							<span>paid</span>
						</div>
						<ul class="p-1 px-6 list-[circle]">
							{#each Object.keys(e.shares_json) as userEmail (userEmail)}
								{@const userInfo = $allowedUserInfo[userEmail]}
								<li>
									{userInfo.name} - {e.shares_json[userEmail]}
								</li>
							{/each}
						</ul>
					</Accordion.Content>
				</Accordion.Item>
			{/each}
		</Accordion.Root>
	{:else}
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
	{/if}
</ul>
