<script lang="ts">
	import PieChart from '$lib/components/ui/PieChart.svelte';
	import type { PieDatum } from '$lib/components/ui/PieChart.svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';
	import { expensesStore } from '$lib/stores/expenses.store';
	import { categoriesStore } from '$lib/stores/categories.store';
	import { derived } from 'svelte/store';
	import type { ExpenseRow } from '$lib/types/expense';
	import { getCategoryIcon } from '$lib/utils/category-icons';
	import Icon from '@iconify/svelte';

	let scope = $state<'personal' | 'household'>('personal');
	let expanded: Record<string, boolean> = $state({});

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

	function groupByCategory(rows: ExpenseRow[], scopeSel: 'personal' | 'household') {
		const list = rows.filter((e) => e.scope === scopeSel);
		const mapObj: Record<string, { id: string; amount: number; items: ExpenseRow[] }> = {};
		for (const r of list) {
			const id = r.category_id ?? 'uncategorized';
			if (!mapObj[id]) {
				mapObj[id] = { id, amount: 0, items: [] };
			}
			mapObj[id].amount += r.amount;
			mapObj[id].items.push(r);
		}
		const groups = Object.values(mapObj);
		groups.sort((a, b) => b.amount - a.amount);
		return groups;
	}

	const groups = $derived(groupByCategory($items, scope));
	const pieData: PieDatum[] = $derived(
		groups.map((g) => ({
			label: $categoryLabelMap[g.id] ?? (g.id === 'uncategorized' ? '未分類' : g.id),
			value: g.amount,
		}))
	);

	function toggleExpand(id: string) {
		expanded[id] = !expanded[id];
	}
</script>

<section class="card p-4">
	<!-- 切換 personal / household -->
	<div class="flex items-center justify-center gap-2 mb-3">
		<button
			class="px-3 py-1 rounded-md border border-black/10 data-[active=true]:bg-[var(--c-bg)]"
			data-active={scope === 'personal'}
			onclick={() => (scope = 'personal')}
		>
			個人
		</button>
		<button
			class="px-3 py-1 rounded-md border border-black/10 data-[active=true]:bg-[var(--c-bg)]"
			data-active={scope === 'household'}
			onclick={() => (scope = 'household')}
		>
			家庭
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

<style>
	button[data-active='true'] {
		font-weight: 600;
	}
</style>
