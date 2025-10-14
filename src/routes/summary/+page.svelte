<script lang="ts">
	import PieChart from '$lib/components/ui/PieChart.svelte';
	import type { PieDatum } from '$lib/components/ui/PieChart.svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';
	import * as expensesStore from '$lib/stores/expenses.store';
	import * as sessionStore from '$lib/stores/session.store';
	import * as categoriesStore from '$lib/stores/categories.store';
	import { derived } from 'svelte/store';
	import type { ExpenseRow, ExpenseScope } from '$lib/types/expense';
	import { getCategoryIcon } from '$lib/utils/category-icons';
	import Icon from '@iconify/svelte';
	// 新增：月份選擇 Dialog 與台灣月份邊界
	import { Dialog } from 'bits-ui';
	import { taiwanMonthBoundsISO } from '$lib/utils/dates';

	let scope = $state<ExpenseScope>('personal');
	let expanded: Record<string, boolean> = $state({});
	const { user } = sessionStore;

	// 新增：月份選擇狀態
	const today = new Date();
	function toYearMonth(d: Date) {
		console.log('toYearMonth called with date:', d.toISOString());
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
	let wasMonthPickerOpen = $state(false);

	const items = expensesStore.items;

	const categoryItems = categoriesStore.items;
	const expenseOptions = categoriesStore.expenseOptions;
	const categoryIconMap = derived(categoryItems, (arr) => {
		const entries = arr.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});
	const categoryLabelMap = derived(
		expenseOptions,
		(opts) => Object.fromEntries(opts.map((o) => [o.value, o.label])) as Record<string, string>
	);

	function groupByCategory(rows: ExpenseRow[], scopeSel: ExpenseScope) {
		const list = scopeSel === 'personal' ? rows : rows.filter((e) => e.scope === scopeSel);
		const mapObj: Record<string, { id: string; amount: number; items: ExpenseRow[] }> = {};
		for (const r of list) {
			const id = r.category_id ?? 'uncategorized';
			if (!mapObj[id]) {
				mapObj[id] = { id, amount: 0, items: [] };
			}

			if (r.scope === 'personal') {
				mapObj[id].amount += r.shares_json?.[$user?.email ?? ''] ?? 0;
			} else if (r.scope === 'household') {
				mapObj[id].amount += r.amount;
			}
			mapObj[id].items.push(r);
		}
		const groups = Object.values(mapObj);
		groups.sort((a, b) => b.amount - a.amount);
		return groups;
	}

	// 依選擇月份的 UTC 邊界（台灣時區）
	const monthBounds = $derived(
		(() => {
			const [y, m] = selectedMonth.split('-').map(Number);
			return taiwanMonthBoundsISO(y, m);
		})()
	);
	// 當月篩選後分組
	const groups = $derived(
		groupByCategory(
			($items ?? []).filter((e) => e.ts >= monthBounds.from && e.ts <= monthBounds.to),
			scope
		)
	);
	const pieData: PieDatum[] = $derived(
		groups.map((g) => ({
			label: $categoryLabelMap[g.id] ?? (g.id === 'uncategorized' ? '未分類' : g.id),
			value: g.amount,
		}))
	);

	function toggleExpand(id: string) {
		expanded[id] = !expanded[id];
	}

	// 關閉月份 Dialog 時載入所選月份
	function confirmMonth() {
		showMonthPicker = false;
	}

	$effect(() => {
		if (wasMonthPickerOpen && !showMonthPicker) {
			const [y, m] = selectedMonth.split('-').map(Number);
			if (expensesStore.getMonthExpenses(y, m).length === 0) {
				void expensesStore.loadMonthByDate(`${selectedMonth}-01`);
			}
		}
		wasMonthPickerOpen = showMonthPicker;
	});

	$effect(() => {
		console.log('Selected month changed to:', selectedMonth);
		console.log('Month bounds:', monthBounds);
		console.log(
			'filtered items:',
			($items ?? []).filter((e) => {
				// console.log('Checking item ts:', e.ts);
				return e.ts >= monthBounds.from && e.ts <= monthBounds.to;
			})
		);
	});
</script>

<section class="card p-4">
	<!-- 切換 personal / household -->
	<div class="flex items-center justify-center gap-2 mb-3">
		<button
			class="px-3 py-1 rounded-md border border-black/10 data-[active=true]:bg-[var(--c-bg)]"
			data-active={scope === 'personal'}
			onclick={() => (scope = 'personal')}
		>
			我的花費
		</button>
		<button
			class="px-3 py-1 rounded-md border border-black/10 data-[active=true]:bg-[var(--c-bg)]"
			data-active={scope === 'household'}
			onclick={() => (scope = 'household')}
		>
			共同花費
		</button>
	</div>

	<!-- 當前月份顯示與選擇 -->
	<div class="flex items-center justify-center mb-2">
		<button
			class="px-3 py-1 rounded-md hover:bg-black/5"
			onclick={() => (showMonthPicker = true)}
		>
			{formatYM(selectedMonth)}
		</button>
	</div>

	<!-- 圓餅圖 -->
	<div class="flex justify-center">
		<PieChart data={pieData} size={220} thickness={26} />
	</div>

	<!-- 類別列表 -->
	<div class="mt-4 divide-y divide-black/5">
		{#if groups.length === 0}
			<p class="text-sm opacity-60">本月無資料</p>
		{:else}
			{#each groups as g (g.id)}
				<div class="py-2">
					<button
						class="w-full flex items-center justify-between gap-3"
						onclick={() => toggleExpand(g.id)}
					>
						<div class="flex items-center gap-3 min-w-0">
							<div
								class="w-8 h-8 grid place-items-center rounded-lg bg-[var(--c-bg)]"
							>
								{#if $categoryIconMap[g.id]}
									<Icon icon={$categoryIconMap[g.id]} width={16} height={16} />
								{:else}
									💸
								{/if}
							</div>
							<div class="text-sm font-medium truncate">
								{$categoryLabelMap[g.id] ??
									(g.id === 'uncategorized' ? '未分類' : g.id)}
							</div>
						</div>
						<div class="tabular-nums font-semibold">{g.amount}</div>
					</button>

					{#if expanded[g.id]}
						<div class="mt-2">
							<ExpenseListSection
								items={g.items}
								categoryIconMap={$categoryIconMap}
								showEdit={false}
							/>
						</div>
					{/if}
				</div>
			{/each}
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
				<button class="btn btn-primary" onclick={confirmMonth}>完成</button>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	button[data-active='true'] {
		font-weight: 600;
	}
</style>
