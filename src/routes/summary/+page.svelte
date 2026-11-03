<script lang="ts">
	import PieChart from '$lib/components/ui/PieChart.svelte';
	import MonthlyTrend from '$lib/components/summary/MonthlyTrend.svelte';
	import type { PieDatum } from '$lib/components/ui/PieChart.svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';
	import * as ShadcnDialog from '$lib/components/shadcn/dialog';
	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';

	import * as expensesStore from '$lib/stores/expenses.store';
	import * as sessionStore from '$lib/stores/session.store';
	import * as categoriesStore from '$lib/stores/categories.store';
	import { derived } from 'svelte/store';
	import type { ExpenseScope } from '$lib/types/expense';
	import { groupMonthExpensesByCategory } from '$lib/utils/summary';
	import { summaryChartLabel } from '$lib/utils/summary-chart-label';
	import { createCategoryColorMap, getCategoryColor } from '$lib/utils/category-colors';
	import { getCategoryIcon } from '$lib/utils/category-icons';
	import Icon from '@iconify/svelte';
	// 新增：月份選擇 Dialog 與台灣月份邊界
	import { Dialog, Accordion } from 'bits-ui';
	import { toTaiwanDateString } from '$lib/utils/dates';
	import { ensureMonthLoaded } from '$lib/data/month-loader';
	import { getIsMobile } from '$lib/utils/detect-device';
	import Logger from '$lib/utils/logger';

	let selectedScope = $state<ExpenseScope>('personal');
	const { user } = sessionStore;
	const isMobile = getIsMobile();

	// 新增：月份選擇狀態
	const today = new Date();
	function toYearMonth(d: Date) {
		Logger.log('toYearMonth called with date:', d.toISOString());
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		return `${y}-${m}`;
	}

	function formatYM(ym: string) {
		const [y, m] = ym.split('-');
		return `${y}/${Number(m)}`;
	}
	let selectedMonth = $state(toYearMonth(today));
	let showMonthPicker = $state(false);

	let drawerOpen = $state(false);
	let expenseId = $state('');
	// For editing expense item
	let selectedDate = $state(toYearMonth(today));

	const categoryItems = categoriesStore.items;
	const expenseOptions = categoriesStore.expenseOptions;
	const categoryColors = derived(categoryItems, createCategoryColorMap);
	const categoryIconMap = derived(categoryItems, (arr) => {
		const entries = arr.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});
	const categoryLabelMap = derived(
		expenseOptions,
		(opts) => Object.fromEntries(opts.map((o) => [o.value, o.label])) as Record<string, string>
	);

	// Recomputed whenever the rows, the month, the scope, or the user changes, so switching
	// back to an already-loaded month (even an empty one) shows that month's totals.
	const expenseItems = expensesStore.items;
	const categoryGroups = $derived(
		groupMonthExpensesByCategory(
			$expenseItems,
			selectedMonth,
			selectedScope,
			$user?.email ?? ''
		)
	);

	const coloredCategoryGroups = $derived(
		categoryGroups.map((g) => ({
			...g,
			color: getCategoryColor(g.id, g.amount, $categoryColors)
		}))
	);

	// 當月篩選後分組
	const pieData: PieDatum[] = $derived(
		coloredCategoryGroups.map((g) => ({
			color: g.color,
			label: $categoryLabelMap[g.id] ?? (g.id === 'uncategorized' ? '未分類' : g.id),
			value: g.amount
		}))
	);

	// 關閉月份 Dialog 時載入所選月份
	async function handleCloseMonthSelector() {
		showMonthPicker = false;
		await fetchMonthlyExpenses();
	}

	async function fetchMonthlyExpenses() {
		const [y, m] = selectedMonth.split('-').map(Number);
		// Rows already in the store (e.g. an approved scheduled expense) do not mean the
		// whole month was loaded, so check the loaded-month record instead.
		await ensureMonthLoaded(`${y}-${String(m).padStart(2, '0')}`);
	}
</script>

<section class="card p-4 mb-[10vh]">
	<!-- 切換 personal / household -->
	<div class="flex items-center justify-center gap-2 mb-3">
		<button
			class="px-3 py-1 rounded-md border border-black/10 data-[active=true]:bg-[var(--c-bg)]"
			data-active={selectedScope === 'personal'}
			onclick={() => {
				selectedScope = 'personal';
			}}
		>
			我的花費
		</button>
		<button
			class="px-3 py-1 rounded-md border border-black/10 data-[active=true]:bg-[var(--c-bg)]"
			data-active={selectedScope === 'household'}
			onclick={() => {
				selectedScope = 'household';
			}}
		>
			共同花費
		</button>
	</div>

	<!-- 當前月份顯示與選擇 -->
	<div class="flex items-center justify-center mb-2">
		{#if $isMobile}
			<input
				type="month"
				value={selectedMonth}
				class="px-3 py-1 rounded-md bg-[var(--c-bg)]"
				max={toYearMonth(today)}
				oninput={(e) => {
					const target = e.target as HTMLInputElement;
					if (!target.value) {
						selectedMonth = toYearMonth(today);
						fetchMonthlyExpenses();
						return;
					}
					selectedMonth = target.value;
					fetchMonthlyExpenses();
				}}
			/>
		{:else}
			<button
				class="px-3 py-1 rounded-md hover:bg-black/5"
				onclick={() => (showMonthPicker = true)}
			>
				{formatYM(selectedMonth)}
			</button>
		{/if}
	</div>

	<!-- 圓餅圖 -->
	<div class="flex justify-center">
		<PieChart
			data={pieData}
			size={220}
			thickness={26}
			showLegend={false}
			ariaLabel={summaryChartLabel(pieData)}
		/>
	</div>

	<MonthlyTrend
		email={$user?.email ?? ''}
		scope={selectedScope}
		viewedMonth={selectedMonth}
		onSwitch={async (month) => {
			await ensureMonthLoaded(month);
			selectedMonth = month;
		}}
	/>

	<!-- 類別列表 -->
	<div class="mt-4 divide-y divide-black/5">
		{#if categoryGroups.length === 0}
			<p class="text-sm opacity-60">本月無資料</p>
		{:else}
			<Accordion.Root type="single">
				{#each coloredCategoryGroups as g (g.id)}
					<Accordion.Item value={g.id} class="group p-1.5" data-category-id={g.id}>
						<Accordion.Header>
							<Accordion.Trigger
								class="relative w-full flex items-center justify-between gap-3 transition-all [&[data-state=open]>div>svg]:rotate-180"
							>
								<span
									aria-hidden="true"
									data-category-dot
									class="absolute -left-1.5 size-1 rounded-full"
									style:background-color={g.color}
								></span>
								<div class="flex items-center gap-3 min-w-0">
									<div
										class="w-8 h-8 grid place-items-center rounded-lg bg-[var(--c-bg)]"
									>
										{#if $categoryIconMap[g.id]}
											<Icon
												icon={$categoryIconMap[g.id]}
												width={16}
												height={16}
											/>
										{:else}
											💸
										{/if}
									</div>
									<div class="text-sm font-medium truncate">
										{$categoryLabelMap[g.id] ??
											(g.id === 'uncategorized' ? '未分類' : g.id)}
									</div>
								</div>
								<div class="flex items-center gap-3">
									<div class="tabular-nums font-semibold">{g.amount}</div>
									<Icon
										icon="mdi:caret"
										class="size-[18px] transition-transform duration-200"
										width="24"
										height="24"
									/>
								</div>
							</Accordion.Trigger>
						</Accordion.Header>
						<Accordion.Content
							class="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm tracking-[-0.01em]"
						>
							<div class="mt-2">
								<ExpenseListSection
									items={g.items}
									categoryIconMap={$categoryIconMap}
									showEdit={true}
									showDate={true}
									sectionClassname="px-3 bg-[var(--c-muted)]/25 rounded-md"
									hideIcon={true}
									onEdit={(e) => {
										expenseId = e.id;
										selectedDate = toTaiwanDateString(e.ts);
										drawerOpen = true;
									}}
								/>
							</div></Accordion.Content
						>
					</Accordion.Item>
				{/each}
			</Accordion.Root>
		{/if}
	</div>
</section>

<!-- 月份選擇 Dialog -->
<Dialog.Root bind:open={showMonthPicker}>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 bg-black/40" />
		<Dialog.Content class="card fixed inset-x-6 top-[25vh] p-5">
			<Dialog.Title class="font-semibold">選擇月份</Dialog.Title>
			<input
				type="month"
				bind:value={selectedMonth}
				class="mt-2 w-full"
				max={toYearMonth(today)}
			/>
			<div class="mt-4 flex justify-end">
				<button class="btn btn-primary" onclick={handleCloseMonthSelector}>完成</button>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<ShadcnDialog.Root bind:open={drawerOpen}>
	<ShadcnDialog.Content class="max-h-[75vh] overflow-y-auto sm:max-w-[425px]">
		<ShadcnDialog.Header>
			<ShadcnDialog.Title>編輯項目</ShadcnDialog.Title>
		</ShadcnDialog.Header>
		<ExpenseDrawerContent
			{expenseId}
			{selectedDate}
			editMode={true}
			onSubmitFinish={() => {
				drawerOpen = false;
			}}
		/>
	</ShadcnDialog.Content>
</ShadcnDialog.Root>

<style>
	button[data-active='true'] {
		font-weight: 600;
	}
</style>
