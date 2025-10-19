<script lang="ts">
	import { Dialog, Switch } from 'bits-ui';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';
	import * as categoriesStore from '$lib/stores/categories.store';
	import * as expensesStore from '$lib/stores/expenses.store';
	import * as sessionStore from '$lib/stores/session.store';
	import { derived, get } from 'svelte/store';
	import { listExpenses } from '$lib/data/expenses.fetcher';
	import type { ExpenseRow } from '$lib/types/expense';
	import { getCategoryIcon } from '$lib/utils/category-icons';
	import { taiwanDayBoundsISO, taiwanMonthBoundsISO } from '$lib/utils/dates';
	import { SvelteSet } from 'svelte/reactivity';
	import { allowedUserNames } from '$lib/stores/appSetting.store';

	const mockdata: ExpenseRow[] = [
		{
			id: 'fba857f3-50d5-4702-9239-77338ef5155f',
			ts: '2025-10-10T18:07:46.644419+00:00',
			payer_email: 'zxp930110gg@gmail.com',
			amount: 30,
			currency: 'TWD',
			category_id: '92bbede9-5479-4b88-9bf8-84200dddc326',
			note: 'test1011',
			shares_json: {
				'zxp930110gg@gmail.com': 10,
				'lionheart0721@gmail.com': 20,
			},
			meta: '',
			created_at: '2025-10-10T18:07:46.644419+00:00',
			updated_at: '2025-10-10T18:07:46.644419+00:00',
			scope: 'household',
			is_settled: false,
		},
		{
			id: 'e4ff948d-c003-41c4-8e8d-d1d4eab73b54',
			ts: '2025-10-10T18:05:52.071184+00:00',
			payer_email: 'zxp930110gg@gmail.com',
			amount: 100,
			currency: 'TWD',
			category_id: 'b32edcd1-2670-46e6-b6ca-d41d0e5537d4',
			note: 'test',
			shares_json: {
				'zxp930110gg@gmail.com': 100,
			},
			meta: '',
			created_at: '2025-10-10T18:05:52.071184+00:00',
			updated_at: '2025-10-10T18:05:52.071184+00:00',
			scope: 'personal',
			is_settled: true,
		},
		{
			id: '12af8f11-5edd-46e8-8eac-ffa891e42c0a',
			ts: '2025-10-07T02:54:46.055433+00:00',
			payer_email: 'zxp930110gg@gmail.com',
			amount: 150,
			currency: 'TWD',
			category_id: 'b32edcd1-2670-46e6-b6ca-d41d0e5537d4',
			note: '個人日用品-刮鬍刀',
			shares_json: {
				'zxp930110gg@gmail.com': 150,
			},
			meta: '',
			created_at: '2025-10-07T08:54:46.055433+00:00',
			updated_at: '2025-10-12T04:06:18.874595+00:00',
			scope: 'personal',
			is_settled: true,
		},
		{
			id: '8d261802-91f6-443c-abc8-55945cab3c7d',
			ts: '2025-10-06T08:54:46.055433+00:00',
			payer_email: 'lionheart0721@gmail.com',
			amount: 65,
			currency: 'TWD',
			category_id: 'd7af609c-cebf-4083-b0ba-ca021e9b6814',
			note: '個人飲料-紅茶',
			shares_json: {
				'lionheart0721@gmail.com': 65,
			},
			meta: '',
			created_at: '2025-10-07T08:54:46.055433+00:00',
			updated_at: '2025-10-07T08:58:41.728007+00:00',
			scope: 'personal',
			is_settled: false,
		},
		{
			id: '2fdbb094-2036-4ab9-a819-f6807ab7bc05',
			ts: '2025-10-06T07:36:04.005269+00:00',
			payer_email: 'zxp930110gg@gmail.com',
			amount: 4400,
			currency: 'TWD',
			category_id: 'd3a247fe-f89b-4e0d-b51b-b669046965f8',
			note: '台中一日遊',
			shares_json: {
				'zxp930110gg@gmail.com': 2300,
				'lionheart0721@gmail.com': 2100,
			},
			meta: '',
			created_at: '2025-10-07T07:36:04.005269+00:00',
			updated_at: '2025-10-12T04:07:12.622718+00:00',
			scope: 'household',
			is_settled: false,
		},
		{
			id: '0e108d26-543a-428c-9d84-7a0c898eb689',
			ts: '2025-10-05T08:54:46.055433+00:00',
			payer_email: 'zxp930110gg@gmail.com',
			amount: 75,
			currency: 'TWD',
			category_id: 'b32edcd1-2670-46e6-b6ca-d41d0e5537d4',
			note: '個人早餐-蛋餅',
			shares_json: {
				'zxp930110gg@gmail.com': 75,
			},
			meta: '',
			created_at: '2025-10-07T08:54:46.055433+00:00',
			updated_at: '2025-10-07T08:57:55.546024+00:00',
			scope: 'personal',
			is_settled: false,
		},
		{
			id: '13825997-7d12-4c86-b5c0-60440b986557',
			ts: '2025-10-05T07:36:04.005269+00:00',
			payer_email: 'lionheart0721@gmail.com',
			amount: 340,
			currency: 'TWD',
			category_id: '5508055e-28ba-47cd-a68a-875360363080',
			note: '家樂福衛生紙、洗衣精',
			shares_json: {
				'zxp930110gg@gmail.com': 170,
				'lionheart0721@gmail.com': 170,
			},
			meta: '',
			created_at: '2025-10-07T07:36:04.005269+00:00',
			updated_at: '2025-10-07T08:54:46.055433+00:00',
			scope: 'household',
			is_settled: false,
		},
		{
			id: 'e8d92c98-0515-4dbe-aefa-79025ba04c8b',
			ts: '2025-10-04T07:36:04.005269+00:00',
			payer_email: 'lionheart0721@gmail.com',
			amount: 140,
			currency: 'TWD',
			category_id: 'd7af609c-cebf-4083-b0ba-ca021e9b6814',
			note: '珍煮丹奶茶',
			shares_json: {
				'zxp930110gg@gmail.com': 70,
				'lionheart0721@gmail.com': 70,
			},
			meta: '',
			created_at: '2025-10-07T07:36:04.005269+00:00',
			updated_at: '2025-10-07T08:54:46.055433+00:00',
			scope: 'household',
			is_settled: false,
		},
		{
			id: 'e43758e8-13ec-4d6d-b9a7-cc22dc6665e8',
			ts: '2025-10-02T07:36:04.005269+00:00',
			payer_email: 'zxp930110gg@gmail.com',
			amount: 800,
			currency: 'TWD',
			category_id: 'c962ebd4-3439-4eac-a465-b892392b6f40',
			note: '火鍋',
			shares_json: {
				'zxp930110gg@gmail.com': 400,
				'lionheart0721@gmail.com': 400,
			},
			meta: '',
			created_at: '2025-10-07T07:36:04.005269+00:00',
			updated_at: '2025-10-07T08:54:46.055433+00:00',
			scope: 'household',
			is_settled: false,
		},
		{
			id: 'ec38f332-629f-4f1c-a89a-4f99d6261255',
			ts: '2025-10-01T07:36:04.005269+00:00',
			payer_email: 'lionheart0721@gmail.com',
			amount: 500,
			currency: 'TWD',
			category_id: 'a8e0bb28-7c4b-4242-9ee2-bf138f9e64ad',
			note: '朋友生日禮物',
			shares_json: {
				'zxp930110gg@gmail.com': 250,
				'lionheart0721@gmail.com': 250,
			},
			meta: '',
			created_at: '2025-10-07T07:36:04.005269+00:00',
			updated_at: '2025-10-07T08:54:46.055433+00:00',
			scope: 'household',
			is_settled: false,
		},
	];

	// 類別圖示 map
	const categoryItems = categoriesStore.items;
	const categoryIconMap = derived(categoryItems, (itemsArr) => {
		const entries = itemsArr.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});

	// 預設區間：台灣當月
	const now = new Date();
	const monthBounds = taiwanMonthBoundsISO(now.getFullYear(), now.getMonth() + 1);
	function isoToTaiwanDateStr(iso: string) {
		const d = new Date(iso);
		const t = new Date(d.getTime() + 8 * 60 * 60 * 1000); // UTC+8
		const y = t.getUTCFullYear();
		const m = String(t.getUTCMonth() + 1).padStart(2, '0');
		const da = String(t.getUTCDate()).padStart(2, '0');
		return `${y}-${m}-${da}`;
	}

	let startDate = $state(isoToTaiwanDateStr(monthBounds.from));
	let endDate = $state(isoToTaiwanDateStr(monthBounds.to));
	let showRangePicker = $state(false);

	let loading = $state(false);
	let rows = $state<ExpenseRow[]>([]);
	let selected = $state<string[]>([]);
	let selectAll = $state(false);

	// 顯示當前使用者算式
	let showFormula = $state(false);

	const userStore = sessionStore.user;

	async function fetchData() {
		// 驗證
		if (endDate < startDate) {
			alert('結束日期需大於等於開始日期');
			return;
		}
		loading = true;
		try {
			// const fromISO = taiwanDayBoundsISO(startDate).from;
			// const toISO = taiwanDayBoundsISO(endDate).to;
			// const page = await listExpenses({
			// 	from: fromISO,
			// 	to: toISO,
			// 	scope: 'household',
			// 	settled: 'only_unsettled',
			// 	limit: 1000,
			// });
			// rows = page.items;
			rows = mockdata;
			selected = [];
			selectAll = false;
		} catch (e) {
			console.error(e);
			alert('讀取失敗');
		} finally {
			loading = false;
			showRangePicker = false;
		}
	}

	$effect(() => {
		console.log('selected items', selected);
	});

	$effect(() => {
		// 初始化載入
		if (rows.length === 0) {
			fetchData();
		}
	});

	function toggleOne(e: CustomEvent<{ id: string; checked: boolean }>) {
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
	const myFormula = $derived(() => {
		if (!currentUser?.email || selectedRows.length === 0) {
			return '';
		}
		const paidTerms: number[] = [];
		const oweTerms: number[] = [];
		for (const r of selectedRows) {
			if (r.payer_email === currentUser.email) {
				paidTerms.push(r.amount);
			}
			const s = r.shares_json?.[currentUser.email] ?? 0;
			if (s > 0) {
				oweTerms.push(s);
			}
		}
		const paidSum = paidTerms.reduce((a, v) => a + v, 0);
		const oweSum = oweTerms.reduce((a, v) => a + v, 0);
		const left =
			(paidTerms.length ? paidTerms.join(' + ') : '0') +
			' - (' +
			(oweTerms.length ? oweTerms.join(' + ') : '0') +
			')';
		return `${left} = ${paidSum - oweSum}`;
	});

	const net = $derived(computeNetByEmail(selectedRows));
	const transfers = $derived(computeTransfers(net));

	async function startSettle() {
		if (selected.length === 0) {
			alert('請先選擇要結清的項目');
			return;
		}
		try {
			await expensesStore.markSettledBulk({ ids: [...selected], next: true });
			// 畫面上移除已結清項
			rows = rows.filter((r) => !selected.includes(r.id));
			selected = [];
			selectAll = false;
		} catch (e) {
			console.error(e);
			alert('結清失敗');
		}
	}
</script>

<section class="card p-4 mb-[10vh] flex flex-col gap-3">
	<!-- 範圍 + 開關 -->
	<div class="flex items-center justify-between gap-3">
		<button
			class="px-3 py-1 rounded-md border border-black/10"
			onclick={() => (showRangePicker = true)}
		>
			範圍：{startDate} ~ {endDate}
		</button>
	</div>

	<!-- 操作列：全選 + 結清 -->

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
					<li>{$allowedUserNames[t.from]} → {$allowedUserNames[t.to]}:{t.amount}</li>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- 用 Bits UI 的 Switch 控制是否顯示算式（預設 false） -->
	<Switch.Root bind:checked={showFormula} class="flex items-center gap-2">
		<span>顯示我的算式</span>
		<Switch.Thumb />
	</Switch.Root>

	<!-- 我的算式（受 Switch 控制） -->
	{#if showFormula && myFormula}
		<div class="mt-3 text-xs opacity-80">
			我的算式：{myFormula}
		</div>
	{/if}

	<button
		class="btn btn-primary"
		disabled={selected.length === 0 || loading}
		onclick={startSettle}
	>
		Start settle
	</button>
</section>

<!-- Date Range Dialog -->
<Dialog.Root bind:open={showRangePicker}>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 bg-black/40" />
		<Dialog.Content class="card fixed inset-x-6 top-[20vh] p-5">
			<Dialog.Title class="font-semibold">選擇日期區間（台灣時區）</Dialog.Title>
			<div class="mt-3 grid grid-cols-2 gap-3">
				<div>
					<label class="text-sm">開始</label>
					<input type="date" class="mt-1 w-full" bind:value={startDate} />
				</div>
				<div>
					<label class="text-sm">結束</label>
					<input type="date" class="mt-1 w-full" bind:value={endDate} />
				</div>
			</div>
			<div class="mt-4 flex justify-end gap-2">
				<button class="btn" onclick={() => (showRangePicker = false)}>取消</button>
				<button class="btn btn-primary" onclick={fetchData}>套用</button>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
