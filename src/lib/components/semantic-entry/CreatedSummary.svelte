<script lang="ts">
	import { toISODateOnly } from '$lib/utils/dates';
	import Check from 'lucide-svelte/icons/check';
	import type { ExpenseRow } from '$lib/types/expense';
	import { expenseOptions } from '$lib/stores/categories.store';
	let { expenses }: { expenses: ExpenseRow[] } = $props();
	const total = $derived(expenses.reduce((sum, row) => sum + row.amount, 0));
	const date = (ts: string) => toISODateOnly(new Date(Date.parse(ts) + 8 * 60 * 60 * 1000));
	const category = (row: ExpenseRow) =>
		$expenseOptions.find((c) => c.value === row.category_id)?.label ?? '—';
	const scope = (row: ExpenseRow) => (row.scope === 'personal' ? '個人' : '家庭');
</script>

<div
	role="group"
	aria-label="已記帳摘要"
	class="space-y-2 rounded-xl border border-green-600/30 bg-green-500/10 p-3"
>
	<p class="flex items-center gap-1 font-semibold text-green-700 dark:text-green-400">
		<Check class="h-4 w-4 shrink-0" aria-hidden="true" />已記帳 {expenses.length} 筆{expenses.length >
		1
			? `，合計 NT$ ${total}`
			: ''}
	</p>
	{#if expenses.length === 1}
		{@const row = expenses[0]}
		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
			<dt>內容</dt>
			<dd class="break-words">{row.note}</dd>
			<dt>金額</dt>
			<dd>NT$ {row.amount}</dd>
			<dt>分類</dt>
			<dd>{category(row)}</dd>
			<dt>日期</dt>
			<dd>{date(row.ts)}</dd>
			<dt>範圍</dt>
			<dd>{scope(row)}</dd>
		</dl>
	{:else}
		{#each expenses as row (row.id)}
			<div class="flex items-start justify-between gap-3 text-sm">
				<div class="min-w-0">
					<p class="break-words">{row.note}</p>
					<p class="text-xs text-muted-foreground">
						{date(row.ts).slice(5).replace('-', '/')} · {scope(row)}{row.scope ===
						'household'
							? '・平分'
							: ''} · {category(row)}
					</p>
				</div>
				<p class="shrink-0">NT$ {row.amount}</p>
			</div>
		{/each}
	{/if}
</div>
<p class="text-xs text-muted-foreground">已加入首頁列表。</p>
