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
	import { taiwanDayBoundsISO, getTaiwanDate } from '$lib/utils/dates';
	import { allowedUserInfo } from '$lib/stores/appSetting.store';
	import DateRangePicker from '$lib/components/ui/DateRangePicker.svelte';
	import classNames from 'classnames';
	import { mockdata } from './mock';

	// 類別圖示 map
	const categoryItems = categoriesStore.items;
	const categoryIconMap = derived(categoryItems, (itemsArr) => {
		const entries = itemsArr.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});

	let fetchLoading = $state(false);
	let settleLoading = $state(false);
	let dateRange = $state<DateRange | undefined>(undefined);

	let rows = $state<ExpenseRow[]>([]);
	let settledTrash = $state<ExpenseRow[]>([]);
	let selected = $state<string[]>([]);
	let selectAll = $state(false);

	// 顯示當前使用者算式
	let showFormula = $state(false);

	const userStore = sessionStore.user;

	async function fetchData(startDateString: string, endDateString: string) {
		fetchLoading = true;
		console.log('fetch start', startDateString, endDateString);

		try {
			const fromISO = taiwanDayBoundsISO(startDateString).from;
			const toISO = taiwanDayBoundsISO(endDateString).to;
			// const page = await listExpenses({
			// 	from: fromISO,
			// 	to: toISO,
			// 	scope: 'household',
			// 	settled: 'only_unsettled',
			// 	limit: 1000,
			// });
			// rows = page.items;
			// console.log('fetch success', rows.length);
			rows = mockdata.filter((md) => md.scope === 'household');
			selected = [];
			selectAll = false;
		} catch (e) {
			console.error(e);
			alert('讀取失敗');
		} finally {
			fetchLoading = false;
		}
	}

	$effect(() => {
		// reset expenses when date selection start
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
			fetchLoading || // is loading
			(startDate && endDate && rows.length > 0) || // data is fetched and we haven't refetch
			!startDate ||
			!endDate ||
			settledTrash.length > 0
		) {
			// console.log('but return')
			return;
		}

		settledTrash = [];
		fetchData(startDate, endDate);
	});

	// $effect(() => {
	// 	// 初始化載入
	// 	if (rows.length === 0) {
	// 		fetchData();
	// 	}
	// });

	function toggleOne(e: CustomEvent<{ id: string; checked: boolean }>) {
		const hasItem = selected.includes(e.detail.id);
		if (e.detail.checked && !hasItem) {
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
	const myCalList: { item: string; amount: number; date: string }[] | [] = $derived.by(() => {
		if (!currentUser?.email) {
			return [];
		}

		return selectedRows
			.filter((r) => r.scope !== 'personal')
			.map((r) => {
				const { month, day } = getTaiwanDate(r.ts);
				if (r.payer_email === currentUser.email) {
					const sum = Object.values(r.shares_json).reduce((acc, cur) => {
						return acc + cur;
					}, 0);
					return {
						item: r.note,
						amount: sum - r.shares_json[r.payer_email],
						date: `${month}/${day}`,
					};
				} else {
					return {
						item: r.note,
						amount: -r.shares_json[currentUser.email],
						date: `${month}/${day}`,
					};
				}
			});
	});

	const net = $derived(computeNetByEmail(selectedRows));
	const transfers = $derived(computeTransfers(net));

	async function startSettle() {
		if (selected.length === 0) {
			alert('請先選擇項目');
			return;
		}

		settleLoading = true;
		try {
			console.log('toggle settle', [...selected]);
			await bulkToggleSettled({ ids: [...selected], next: true });
			alert(`完成結清`);

			settledTrash = rows.filter((r) => selected.includes(r.id));
			// 畫面上移除已結清項
			rows = rows.filter((r) => !selected.includes(r.id));
			selected = [];
			selectAll = false;
		} catch (e) {
			console.error(e);
			alert('結清失敗');
		} finally {
			settleLoading = false;
		}
	}

	async function recoverSettle() {
		if (settledTrash.length === 0) {
			alert('請先完成結清');
			return;
		}

		try {
			console.log(
				'toggle reset',
				settledTrash.map((t) => t.id)
			);
			await bulkToggleSettled({ ids: settledTrash.map((t) => t.id), next: false });

			rows = [...rows, ...settledTrash];
			settledTrash = [];
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
	{#if fetchLoading}
		<div class="flex justify-center">
			<Icon
				icon="svg-spinners:90-ring-with-bg"
				class="text-[var(--c-muted)]"
				width="64px"
				height="64px"
			/>
		</div>
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
				showDate={true}
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
	<div>
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

	<div>
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
			<fieldset class="fieldset bg-base-200 border-base-300 rounded-box w-xs border p-4">
				<legend class="fieldset-legend">列表與算式</legend>
				<p class="label">列表</p>
				<div class="pl-4">
					<ul class="list-decimal">
						{#each myCalList as c, i (i)}
							<li>{c.date} {c.item}: {c.amount}</li>
						{/each}
					</ul>
				</div>

				<p class="label">算式</p>
				<div class="text-xs opacity-80">
					{myFormula}
				</div>
			</fieldset>
		{/if}
	</div>

	<div class="flex w-full gap-2">
		<button
			class="grow btn btn-primary disabled:bg-[var(--c-muted)]!"
			disabled={selected.length === 0 || fetchLoading}
			onclick={startSettle}
		>
			{#if !settleLoading}
				設為結清
			{:else}
				<Icon icon="svg-spinners:90-ring-with-bg" width="24" height="24" />
			{/if}
		</button>
		<button
			class="btn btn-primary p-2! disabled:bg-[var(--c-muted)]!"
			disabled={settledTrash.length === 0}
			onclick={recoverSettle}
		>
			<Icon icon="solar:restart-linear" width="24" height="24" />
		</button>
	</div>
</section>
