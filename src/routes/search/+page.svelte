<script lang="ts">
	import { derived } from 'svelte/store';
	import type { DateValue } from '@internationalized/date';
	import { getLocalTimeZone } from '@internationalized/date';

	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';
	import SwipeDrawer from '$lib/components/ui/SwipeDrawer.svelte';
	import DateRangePicker from '$lib/components/ui/DateRangePicker.svelte';

	import { getCategoryIcon } from '$lib/utils/category-icons';
	import * as categoriesStore from '$lib/stores/categories.store';
	import * as expensesStore from '$lib/stores/expenses.store';

	import { searchExpenses, upsertExpense } from '$lib/data/expenses.fetcher';
	import type { ExpenseRow } from '$lib/types/expense';
	import { Button } from '$lib/components/shadcn/button';
	import { Input } from '$lib/components/shadcn/input';
	import { Search, CircleX } from 'lucide-svelte';

	// 狀態
	let keyword = $state('');
	let dateRange = $state<{ start: DateValue | undefined; end: DateValue | undefined } | undefined>(
		undefined
	);
	let rows = $state<ExpenseRow[]>([]);
	let loading = $state(false);

	// 編輯抽屜狀態
	let drawerOpen = $state(false);
	let selected: ExpenseRow | null = $state(null);
	let amount = $state('');
	let content = $state('');
	let categoryId = $state('');
	let isSettled = $state(false);

	// 類別 icon 對應
	const categoryIconMap = derived(categoriesStore.items, (itemsArr) => {
		const entries = itemsArr.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});
	const expenseOptions = categoriesStore.expenseOptions;

	async function runSearch() {
		try {
			loading = true;
			if (!keyword || !dateRange?.start || !dateRange?.end) {
				rows = [];
				return;
			}
			const page = await searchExpenses({
				text: keyword,
				limit: 50,
				startDate: dateRange?.start?.toDate(getLocalTimeZone()).toISOString(),
				endDate: dateRange?.end?.toDate(getLocalTimeZone()).toISOString()
			});
			rows = page.items;
		} finally {
			loading = false;
		}
	}

	function openEdit(e: ExpenseRow) {
		selected = e;
		amount = String(e.amount);
		content = e.note;
		categoryId = e.category_id ?? '';
		isSettled = e.is_settled;
		drawerOpen = true;
	}

	async function submit() {
		if (!selected) {
			return;
		}
		const payload = {
			id: selected.id,
			note: content,
			amount: Number(amount),
			currency: selected.currency,
			payer_email: selected.payer_email,
			scope: selected.scope,
			shares_json: selected.shares_json,
			category_id: categoryId || selected.category_id || '',
			is_settled: isSettled,
			ts: selected.ts,
			updated_at: new Date().toISOString()
		};
		const saved = await upsertExpense(payload);
		rows = rows.map((r) => (r.id === saved.id ? saved : r));
		expensesStore.upsertOne(saved);
		drawerOpen = false;
	}
</script>

<section class="card p-4 space-y-4">
	<div class="relative">
		<Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
		<Input
			bind:value={keyword}
			placeholder="輸入關鍵字搜尋"
			class="pl-9 pr-16"
			required
		/>
		{#if keyword}
			<button
				class="absolute right-0 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs"
				onclick={() => (keyword = '')}
			>
				<CircleX class="h-4 w-4" />
			</button>
		{/if}
	</div>

	<DateRangePicker bind:value={dateRange} title="日期範圍" />

	<Button class="w-full" onclick={runSearch} disabled={loading}>
		{#if loading}
			<div class="loader-white mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"></div>
			搜尋中
		{:else}
			搜尋
		{/if}
	</Button>

	{#if loading}
		<p class="mt-3 opacity-70">搜尋中…</p>
	{:else if rows.length === 0}
		<p class="mt-3 opacity-60">找不到結果</p>
	{:else}
		<ExpenseListSection
			items={rows}
			categoryIconMap={$categoryIconMap}
			showDate={true}
			showEdit={true}
			onEdit={openEdit}
		/>
	{/if}
</section>

<SwipeDrawer bind:open={drawerOpen} title="編輯項目">
	<ExpenseDrawerContent
		bind:amount
		bind:content
		bind:categoryId
		bind:isSettled
		categoryOptions={$expenseOptions}
		noteLabel="備註"
		submitLabel="儲存"
		onSubmit={submit}
		onCancel={() => (drawerOpen = false)}
	/>
</SwipeDrawer>
