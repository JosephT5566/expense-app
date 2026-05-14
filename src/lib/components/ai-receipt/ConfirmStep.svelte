<script lang="ts">
	import PreviewExpenseCard from './PreviewExpenseCard.svelte';
	import { Button } from '$lib/components/shadcn/button';
	import { upsertExpenses } from '$lib/data/expenses.fetcher';
	import type {
		ExpenseRow,
		ExpenseScope,
		PreviewExpense,
		PreviewGroupExpense
	} from '$lib/types/expense';
	import type { UpsertExpenseInput } from '$lib/data/expenses.fetcher';
	import { user as currentUser } from '$lib/stores/session.store';
	import { Group, Check, X, Ungroup, Eye, EyeOff } from 'lucide-svelte';
	import { SvelteSet } from 'svelte/reactivity';

	let {
		previewExpenses = $bindable([]),
		previewGroupExpenses = $bindable({}),
		onConfirm = undefined as ((expenses: ExpenseRow[]) => void) | undefined
	}: {
		previewExpenses: PreviewExpense[];
		previewGroupExpenses: PreviewGroupExpense;
		onConfirm?: (expenses: ExpenseRow[]) => void;
	} = $props();

	let isSubmitting = $state(false);
	let submitError = $state<string | null>(null);
	let isSelectionMode = $state(false);
	let selectedIds = new SvelteSet<string>();

	// Helper to generate a consistent color based on string
	function getGroupColor(groupId: string | number) {
		const colors = [
			'#3b82f6', // blue
			'#10b981', // emerald
			'#f59e0b', // amber
			'#8b5cf6', // violet
			'#ec4899', // pink
			'#06b6d4' // cyan
		];
		const hash = String(groupId)
			.split('')
			.reduce((acc, char) => acc + char.charCodeAt(0), 0);
		return colors[hash % colors.length];
	}

	const groupedItems = $derived.by(() => {
		// Group items by groupId or auto-grouping if not manually grouped
		const groups: Record<string, PreviewExpense[]> = {};

		previewExpenses.forEach((item, index) => {
			if (item.groupId !== undefined) {
				const key = `manual-${item.groupId}`;
				if (!groups[key]) {
					groups[key] = [];
				}
				groups[key].push(item);
			} else {
				// Auto grouping logic based on same fields
				const key = `auto-${item.note?.trim() || `__missing_${index}`}|${item.currency || 'TWD'}|${item.ts || ''}|${item.scope || 'personal'}|${item.payer_email || ''}`;
				if (!groups[key]) {
					groups[key] = [];
				}
				groups[key].push(item);
			}
		});

		return Object.entries(groups).map(([key, items], index) => {
			const isManual = key.startsWith('manual-');
			const groupId = isManual ? parseInt(key.replace('manual-', ''), 10) : index;
			const color = items.length > 1 ? getGroupColor(groupId) : undefined;
			const groupIsHidden = items.every((item) => item.isHidden);

			// If it's a group, we might want a summary expense
			let summaryExpense: PreviewExpense | null = null;
			if (items.length > 1) {
				if (previewGroupExpenses[groupId]) {
					summaryExpense = previewGroupExpenses[groupId];
				} else {
					const first = items[0];
					const mergedAmount = items.reduce(
						(sum, item) => sum + Number(item.amount ?? 0),
						0
					);
					summaryExpense = {
						...first,
						id: `summary-${groupId}`,
						amount: mergedAmount,
						isGrouped: true,
						groupId: groupId,
						shares_json: first.shares_json || {},
						category_id: first.category_id || ''
					};
				}

				// Sync hidden state to summary
				if (summaryExpense && summaryExpense.isHidden !== groupIsHidden) {
					summaryExpense = { ...summaryExpense, isHidden: groupIsHidden };
				}
			}

			return {
				id: key,
				items,
				groupId,
				color,
				summaryExpense,
				isHidden: groupIsHidden
			};
		});
	});

	function handleUpdate(updated: PreviewExpense) {
		if (updated.id?.startsWith('summary-') && updated.groupId !== undefined) {
			previewGroupExpenses[updated.groupId] = updated;
		} else {
			const index = previewExpenses.findIndex((e) => e.id === updated.id);
			if (index !== -1) {
				previewExpenses[index] = updated;
			}
		}
	}

	function toggleSelection(id: string) {
		if (selectedIds.has(id)) {
			selectedIds.delete(id);
		} else {
			selectedIds.add(id);
		}
	}

	function handleMergeSelected() {
		if (selectedIds.size < 2) {
			return;
		}

		const nextGroupId = Date.now();
		previewExpenses = previewExpenses.map((item) => {
			if (item.id && selectedIds.has(item.id)) {
				return { ...item, groupId: nextGroupId, isGrouped: true };
			}
			return item;
		});

		isSelectionMode = false;
		selectedIds.clear();
	}

	function handleCancelSelection() {
		isSelectionMode = false;
		selectedIds.clear();
	}

	function handleUngroup(items: PreviewExpense[], groupKey: string) {
		const itemIds = new Set(items.map((i) => i.id));
		const isManual = groupKey.startsWith('manual-');
		const manualGroupId = isManual ? parseInt(groupKey.replace('manual-', ''), 10) : null;

		previewExpenses = previewExpenses.map((item, idx) => {
			if (item.id && itemIds.has(item.id)) {
				// 為每個項目分配唯一的 groupId 以確保它們保持獨立（不被自動合併）
				return {
					...item,
					groupId: Date.now() + idx,
					isGrouped: false
				};
			}
			return item;
		});

		if (manualGroupId !== null) {
			// 清理該手動群組的摘要資料
			const newGroupExpenses = { ...previewGroupExpenses };
			delete newGroupExpenses[manualGroupId];
			previewGroupExpenses = newGroupExpenses;
		}
	}

	function handleToggleHideGroup(items: PreviewExpense[], groupId: number) {
		const itemIds = new Set(items.map((i) => i.id));
		const shouldHide = !items.every((item) => item.isHidden);

		previewExpenses = previewExpenses.map((item) => {
			if (item.id && itemIds.has(item.id)) {
				return { ...item, isHidden: shouldHide };
			}
			return item;
		});

		// Sync hidden state to stored summary if it exists
		if (previewGroupExpenses[groupId]) {
			previewGroupExpenses[groupId] = {
				...previewGroupExpenses[groupId],
				isHidden: shouldHide
			};
		}
	}

	function isCompleteExpense(expense: PreviewExpense): expense is ExpenseRow {
		if (!expense.note?.trim()) {
			return false;
		}
		if (
			expense.amount == null ||
			isNaN(Number(expense.amount)) ||
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
		return true;
	}

	const visibleGroups = $derived(groupedItems.filter((g) => !g.isHidden));

	const allValid = $derived(
		visibleGroups.every((group) => {
			if (group.summaryExpense) {
				return isCompleteExpense(group.summaryExpense);
			}
			return group.items.every((item) => isCompleteExpense(item));
		})
	);

	function buildUpsertPayload(expense: PreviewExpense): UpsertExpenseInput {
		return {
			note: expense.note ?? '',
			amount: Number(expense.amount ?? 0),
			currency: expense.currency || 'TWD',
			ts: expense.ts || new Date().toISOString(),
			payer_email: expense.payer_email || $currentUser?.email || '',
			scope: expense.scope as ExpenseScope,
			shares_json:
				expense.scope === 'personal'
					? { [expense.payer_email || '']: Number(expense.amount ?? 0) }
					: expense.shares_json || {},
			category_id: expense.category_id || '',
			is_settled: expense.is_settled ?? expense.scope === 'personal'
		};
	}

	async function handleConfirm() {
		submitError = null;
		if (!allValid) {
			submitError = '請先補齊所有預覽項目的必要欄位。';
			return;
		}

		const payloads = visibleGroups.map((group) => {
			if (group.summaryExpense) {
				return buildUpsertPayload(group.summaryExpense);
			}
			return buildUpsertPayload(group.items[0]);
		});

		try {
			isSubmitting = true;
			const savedExpenses = await upsertExpenses(payloads);
			onConfirm?.(savedExpenses);
			previewExpenses = [];
			previewGroupExpenses = {};
		} catch (error) {
			submitError = '匯入時發生錯誤，請稍後再試。';
			console.error(error);
		} finally {
			isSubmitting = false;
		}
	}
</script>

<div class="flex flex-col min-h-full">
	<!-- Sticky Header -->
	<div class="sticky top-0 z-20 -mx-1 bg-popover/95 px-1 py-1 backdrop-blur-sm">
		<div class="flex items-center justify-between">
			<p class="text-sm font-medium text-muted-foreground">整理項目並送出：</p>
			{#if !isSelectionMode}
				<Button
					variant="ghost"
					size="sm"
					class="h-8 gap-1 text-xs"
					onclick={() => (isSelectionMode = true)}
				>
					<Group class="size-3" />
					合併
				</Button>
			{:else}
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						class="h-8 gap-1 text-xs"
						onclick={handleCancelSelection}
					>
						<X class="size-3" />
						取消
					</Button>
					<Button
						variant="default"
						size="sm"
						class="h-8 gap-1 text-xs"
						disabled={selectedIds.size < 2}
						onclick={handleMergeSelected}
					>
						<Check class="size-3" />
						合併所選 ({selectedIds.size})
					</Button>
				</div>
			{/if}
		</div>
		<div class="absolute bottom-0 left-0 right-0 h-px bg-border/50"></div>
	</div>

	<!-- Scrollable Content Area -->
	<div class="flex-1 space-y-4 py-4">
		{#each groupedItems as group (group.id)}
			<div class="flex gap-1">
				{#if !isSelectionMode}
					<div class="flex flex-col gap-1 pt-1 shrink-0">
						<Button
							variant="ghost"
							size="icon"
							class="h-6 w-6 text-muted-foreground transition-colors {group.isHidden
								? 'text-primary'
								: 'hover:text-destructive hover:bg-destructive/5'}"
							onclick={() => handleToggleHideGroup(group.items, group.groupId)}
							title={group.isHidden ? '恢復' : '排除'}
						>
							{#if group.isHidden}
								<Eye class="size-4" />
							{:else}
								<EyeOff class="size-4" />
							{/if}
						</Button>

						{#if group.items.length > 1 && !group.isHidden}
							<Button
								variant="ghost"
								size="icon"
								class="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
								onclick={() => handleUngroup(group.items, group.id)}
								title="解除合併"
							>
								<Ungroup class="size-4" />
							</Button>
						{/if}
					</div>
				{/if}

				<div
					class="flex-1 grid gap-3"
					class:grid-cols-[1fr_100px]={group.summaryExpense && !isSelectionMode}
					class:grid-cols-1={!group.summaryExpense || isSelectionMode}
				>
					<div class="min-w-0">
						<ul class="space-y-2">
							{#each group.items as item (item.id)}
								<li>
									<PreviewExpenseCard
										previewExpense={item}
										onUpdate={handleUpdate}
										{isSelectionMode}
										isSelected={item.id ? selectedIds.has(item.id) : false}
										onSelect={toggleSelection}
										groupColor={group.color}
									/>
								</li>
							{/each}
						</ul>
					</div>

					{#if group.summaryExpense && !isSelectionMode}
						<PreviewExpenseCard
							previewExpense={group.summaryExpense}
							onUpdate={handleUpdate}
							isSummary={true}
							groupColor={group.color}
						/>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if submitError}
		<div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
			{submitError}
		</div>
	{/if}

	<div class="mt-6">
		<Button
			class="w-full"
			variant="secondary"
			disabled={!allValid || isSubmitting || isSelectionMode}
			onclick={handleConfirm}
		>
			{#if isSubmitting}
				處理中…
			{:else}
				確認並匯入項目 ({visibleGroups.length})
			{/if}
		</Button>
	</div>
</div>
