<script lang="ts">
	import { type DateRange } from 'bits-ui';
	import Icon from '@iconify/svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';
	import * as categoriesStore from '$lib/stores/categories.store';
	import * as sessionStore from '$lib/stores/session.store';
	import { derived, get } from 'svelte/store';
	import { listExpenses, bulkToggleSettled } from '$lib/data/expenses.fetcher';
	import type { ExpenseRow } from '$lib/types/expense';
	import { getCategoryIcon } from '$lib/utils/category-icons';
	import { taiwanDayBoundsISO } from '$lib/utils/dates';
	import { allowedUserInfo } from '$lib/stores/appSetting.store';
	import DateRangePicker from '$lib/components/ui/DateRangePicker.svelte';
	import classNames from 'classnames';
	// import { mockdata } from './mock';

	// 類別圖示 map
	const categoryItems = categoriesStore.items;
	const categoryIconMap = derived(categoryItems, (itemsArr) => {
		const entries = itemsArr.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});

	let loading = $state(false);
	let dateRange = $state<DateRange | undefined>(undefined);

	let rows = $state<ExpenseRow[]>([]);
	let settledTrash = $state<ExpenseRow[]>([]);
	let selected = $state<string[]>([]);
	let selectAll = $state(false);

	// 顯示當前使用者算式
	let showFormula = $state(false);

	const userStore = sessionStore.user;

	async function fetchData(startDateString: string, endDateString: string) {
		loading = true;
		console.log('fetch start', startDateString, endDateString);

		try {
			const fromISO = taiwanDayBoundsISO(startDateString).from;
			const toISO = taiwanDayBoundsISO(endDateString).to;
			const page = await listExpenses({
				from: fromISO,
				to: toISO,
				scope: 'household',
				settled: 'only_unsettled',
				limit: 1000,
			});
			rows = page.items;
			// rows = mockdata;
			selected = [];
			selectAll = false;
		} catch (e) {
			console.error(e);
			alert('讀取失敗');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const startDate = dateRange?.start?.toString();
		const endDate = dateRange?.end?.toString();

		if (!startDate || !endDate) {
			console.log('reset data');
			rows = [];
		}
	});

	$effect(() => {
		const startDate = dateRange?.start?.toString();
		const endDate = dateRange?.end?.toString();

		// console.log('try to fetch');
		if (
			loading || // is loading
			(startDate && endDate && rows.length > 0) || // data is fetched and we haven't refetch
			!startDate ||
			!endDate
		) {
			// console.log('but return')
			return;
		}

		fetchData(startDate, endDate);
	});

	// $effect(() => {
	// 	// 初始化載入
	// 	if (rows.length === 0) {
	// 		fetchData();
	// 	}
	// });

	function toggleOne(e: CustomEvent<{ id: string; checked: boolean }>) {
		console.log('toggle one', e.detail.id);
		// const s = new SvelteSet(selected);
		const hasItem = selected.includes(e.detail.id);
		if (e.detail.checked && !hasItem) {
			// s.add(e.detail.id);
			selected = [...selected, e.detail.id];
		} else if (!e.detail.checked && hasItem) {
			selected = selected.filter((s) => s !== e.detail.id);
		}
		selectAll = rows.length > 0 && selected.length === rows.length;
	}

	function toggleAll(checked: boolean) {
		selectAll = checked;
		selected = checked ? rows.map((r) => r.id) : [];
	}

	// 計算結清：根據選擇項目
	const selectedRows = $derived(rows.filter((r) => selected.includes(r.id)));

	function computeNetByEmail(list: ExpenseRow[]) {
		const net: Record<string, number> = {};
		for (const r of list) {
			// 先扣除各自 share
			for (const [email, share] of Object.entries(r.shares_json || {})) {
				net[email] = (net[email] ?? 0) - (Number(share) || 0);
			}
			// 加上付款人支付總額
			net[r.payer_email] = (net[r.payer_email] ?? 0) + r.amount;
		}
		return net;
	}

	function computeTransfers(net: Record<string, number>) {
		const creditors: { email: string; amount: number }[] = [];
		const debtors: { email: string; amount: number }[] = [];
		for (const [email, val] of Object.entries(net)) {
			if (val > 0.000001) {
				creditors.push({ email, amount: val });
			} else if (val < -0.000001) {
				debtors.push({ email, amount: -val });
			}
		}
		creditors.sort((a, b) => b.amount - a.amount);
		debtors.sort((a, b) => b.amount - a.amount);

		const transfers: { from: string; to: string; amount: number }[] = [];
		let i = 0,
			j = 0;
		while (i < debtors.length && j < creditors.length) {
			const pay = Math.min(debtors[i].amount, creditors[j].amount);
			transfers.push({
				from: debtors[i].email,
				to: creditors[j].email,
				amount: Math.round(pay),
			});
			debtors[i].amount -= pay;
			creditors[j].amount -= pay;
			if (debtors[i].amount <= 0.000001) {
				i++;
			}
			if (creditors[j].amount <= 0.000001) {
				j++;
			}
		}
		return transfers;
	}

	// 當前使用者算式
	const currentUser = $derived(get(userStore));
	const myFormula = $derived.by(() => {
		if (!currentUser?.email || selectedRows.length === 0) {
			return '';
		}

		const oweTerms: string[] = [];

		for (const r of selectedRows) {
			if (r.scope === 'personal') {
				continue;
			}
			if (r.payer_email === currentUser.email) {
				// I paid
				const sum = Object.values(r.shares_json).reduce((acc, cur) => {
					return acc + cur;
				}, 0);

				if (sum > 0) {
					oweTerms.push(`+${sum - r.shares_json[r.payer_email]}`);
				}
			} else {
				oweTerms.push(`-${r.shares_json[currentUser.email]}`);
			}
		}
		return oweTerms.join('');
	});

	const net = $derived(computeNetByEmail(selectedRows));
	const transfers = $derived(computeTransfers(net));

	async function startSettle() {
		if (selected.length === 0) {
			alert('請先選擇要結清的項目');
			return;
		}

		try {
			await bulkToggleSettled({ ids: [...selected], next: true });
			settledTrash = rows.filter((r) => selected.includes(r.id));
			// 畫面上移除已結清項
			rows = rows.filter((r) => !selected.includes(r.id));
			selected = [];
			selectAll = false;
		} catch (e) {
			console.error(e);
			alert('結清失敗');
		}
	}

	async function recoverSettle() {
		if (settledTrash.length === 0) {
			alert('請先完成結清');
			return;
		}
		try {
			await bulkToggleSettled({ ids: settledTrash.map((t) => t.id), next: false });
			rows = [...rows, ...settledTrash];
			selected = [];
			selectAll = false;
		} catch (e) {
			console.error(e);
			alert('重置失敗');
		}
	}
</script>

<section class="card p-4 mb-[10vh] flex flex-col gap-3">
	<!-- 範圍 + 開關 -->
	<DateRangePicker title="選擇計算範圍" bind:dateRange />

	<!-- 列表 -->
	{#if loading}
		<p class="mt-3 opacity-70">載入中…</p>
	{:else if rows.length === 0}
		<p class="mt-3 opacity-70">此區間沒有待結清項目</p>
	{:else}
		<div class="mt-3 items-center justify-between">
			<label class="flex items-center gap-2">
				<input
					type="checkbox"
					class="checkbox checkbox-sm"
					checked={selectAll}
					onchange={(e) => toggleAll((e.target as HTMLInputElement).checked)}
				/>
				<span class="text-sm">Select All</span>
			</label>
			<ExpenseListSection
				items={rows}
				categoryIconMap={$categoryIconMap}
				showEdit={false}
				sectionClassname="px-2 bg-[var(--c-muted)]/25 rounded-md"
				hideIcon={false}
				selectable={true}
				selectedIds={selected}
				displayShare={true}
				on:toggle={toggleOne}
			/>
		</div>
	{/if}

	<!-- 建議結清 -->
	<div class="mt-4">
		<h3 class="font-semibold mb-2 text-sm">建議結清</h3>
		{#if selected.length === 0}
			<p class="text-sm opacity-60">尚未選擇項目</p>
		{:else if transfers.length === 0}
			<p class="text-sm opacity-60">已平衡，無需轉帳</p>
		{:else}
			<ul class="text-sm space-y-1">
				{#each transfers as t, i (i)}
					<li>
						{$allowedUserInfo[t.from].name} → {$allowedUserInfo[t.to].name}:{t.amount}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<label class="label">
		<input
			type="checkbox"
			bind:checked={showFormula}
			class={classNames(
				'toggle',
				'border-[var(--c-primary)]/30 before:bg-[var(--c-primary)]/30',
				'checked:border-[var(--c-primary)] checked:before:bg-[var(--c-primary)] checked:text-orange-800'
			)}
		/>
		顯示算式
	</label>

	<!-- 我的算式（受 Switch 控制） -->
	{#if showFormula && myFormula}
		<div class="text-xs opacity-80">
			{myFormula}
		</div>
	{/if}

	<div class="flex w-full gap-2">
		<button
			class="grow btn btn-primary disabled:bg-[var(--c-muted)]!"
			disabled={selected.length === 0 || loading}
			onclick={startSettle}
		>
			設為結清
		</button>
		<button
			class="basis-s btn btn-primary disabled:bg-[var(--c-muted)]!"
			disabled={settledTrash.length === 0}
			onclick={recoverSettle}
		>
			<Icon icon="solar:restart-linear" width="24" height="24" />
		</button>
	</div>
</section>
