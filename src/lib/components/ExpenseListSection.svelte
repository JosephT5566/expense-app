<script lang="ts">
	import ExpenseItemRow from '$lib/components/ExpenseItemRow.svelte';
	import type { ExpenseRow } from '$lib/types/expense';
	import classNames from 'classnames';
	import { Accordion } from 'bits-ui';
	import { allowedUserInfo } from '$lib/stores/appSetting.store';

	let {
		items = [],
		categoryIconMap = {},
		showEdit = true,
		showDate = false,
		sectionClassname,
		hideIcon,
		selectable = false,
		selectedIds = [],
		displayShare = false,
		onEdit = undefined as ((expense: ExpenseRow) => void) | undefined,
		onToggle = undefined as ((args: { id: string; checked: boolean }) => void) | undefined,
	}: {
		items: ExpenseRow[];
		categoryIconMap: Record<string, string>;
		showEdit?: boolean;
		showDate?: boolean;
		sectionClassname?: string;
		hideIcon?: boolean;
		selectable?: boolean;
		selectedIds?: string[];
		displayShare?: boolean;
		onEdit?: (expense: ExpenseRow) => void;
		onToggle?: (args: { id: string; checked: boolean }) => void;
	} = $props();

	const handleCheckboxClicked = (id: string, checked: boolean) => {
		onToggle?.({ id, checked });
	};
	const handleEdit = (expense: ExpenseRow) => {
		onEdit?.(expense);
	};
	const handleToggle = (args: { id: string; checked: boolean }) => {
		onToggle?.(args);
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
								{showDate}
								{selectable}
								{displayShare}
								checked={selectedIds.includes(e.id)}
								onEdit={handleEdit}
								onToggle={handleToggle}
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
									{userInfo.name}: {e.shares_json[userEmail]}
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
				{showDate}
				{selectable}
				checked={selectedIds.includes(e.id)}
				onEdit={handleEdit}
				onToggle={handleToggle}
			/>
		{/each}
	{/if}
</ul>
