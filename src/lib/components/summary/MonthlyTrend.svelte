<script lang="ts">
	import type { Component } from 'svelte';
	import { ChevronDown } from '@lucide/svelte';
	import type { ExpenseScope } from '$lib/types/expense';
	import type { MonthlyBalancePoint } from '$lib/types/monthly-balance';
	import { balanceSeries, recentTaiwanMonths } from '$lib/utils/monthly-balances';
	import { fetchMonthlyBalances } from '$lib/data/monthly-balances.fetcher';
	import {
		balanceRevision,
		balanceCacheKey,
		balanceCacheVersion,
		readBalanceCache,
		writeBalanceCache,
		balanceCacheIsStale
	} from '$lib/cache/monthlyBalances';
	import type { MonthlyMemberBalance } from '$lib/types/monthly-balance';

	let {
		email,
		scope,
		viewedMonth,
		onSwitch
	}: {
		email: string;
		scope: ExpenseScope;
		viewedMonth: string;
		onSwitch: (month: string) => Promise<void>;
	} = $props();
	const id = $props.id();
	let expanded = $state(false);
	let retry = $state(0);
	let rows = $state<MonthlyMemberBalance[] | null>(null);
	let months = $state<string[]>([]);
	let loading = $state(false);
	let failed = $state(false);
	let Chart = $state<Component<{
		points: MonthlyBalancePoint[];
		viewedMonth: string;
		onSwitch: (month: string) => Promise<void>;
	}> | null>(null);
	const points = $derived(balanceSeries(rows ?? [], months, scope));

	$effect(() => {
		const account = email;
		const revision = $balanceRevision;
		const attempt = retry;
		void revision;
		void attempt;
		if (!expanded || !account) {
			return;
		}
		let cancelled = false;
		const version = balanceCacheVersion();
		const window = recentTaiwanMonths();
		months = window;
		rows = null;
		loading = true;
		failed = false;
		const key = balanceCacheKey(account, window[0]);
		async function load() {
			try {
				const chart = await import('./MonthlyTrendChart.svelte');
				if (cancelled) {
					return;
				}
				Chart = chart.default;
				const cached = await readBalanceCache(key);
				if (cancelled) {
					return;
				}
				if (cached) {
					rows = cached.data;
				}
				if (cached && !balanceCacheIsStale(cached)) {
					return;
				}
				const data = await fetchMonthlyBalances(account, window[0]);
				if (cancelled || version !== balanceCacheVersion()) {
					return;
				}
				rows = data;
				await writeBalanceCache(key, data, version);
			} catch {
				if (!cancelled) {
					failed = true;
				}
			} finally {
				if (!cancelled) {
					loading = false;
				}
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	});
</script>

<div class="mt-4 border-t border-black/5 pt-2">
	<button
		type="button"
		class="flex min-h-11 w-full items-center justify-between rounded-md px-2 text-sm font-medium hover:bg-black/5"
		aria-expanded={expanded}
		aria-controls={id}
		onclick={() => (expanded = !expanded)}
	>
		近 6 個月開銷
		<ChevronDown size={16} class={expanded ? 'rotate-180' : ''} />
	</button>
	<div {id}>
		{#if expanded}
			{#if loading && rows === null}<p
					role="status"
					class="py-4 text-center text-sm opacity-60"
				>
					載入近半年資料…
				</p>{/if}
			{#if failed}
				<div role="status" class="py-2 text-sm">
					{rows === null ? '無法載入近半年資料' : '無法更新，顯示上次儲存的資料'}
					<button class="ml-2 underline" onclick={() => (retry += 1)}>重試</button>
				</div>
			{/if}
			{#if rows !== null && Chart}
				{#if rows.length === 0}<p class="py-1 text-sm opacity-60">近半年無開銷紀錄</p>{/if}
				<Chart {points} {viewedMonth} {onSwitch} />
			{/if}
		{/if}
	</div>
</div>
