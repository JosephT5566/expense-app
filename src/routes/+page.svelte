<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Dialog } from 'bits-ui';
	import { listExpenses, upsertExpense } from '$lib/data/expenses.fetcher';
	import type { ExpenseRow } from '$lib/types/expense';
	import type { UpsertExpenseInput } from '$lib/data/expenses.fetcher';
	import SwipeDrawer from '$lib/components/ui/SwipeDrawer.svelte';
	import Calculator from '$lib/components/ui/Calculator.svelte';
	import Carousel from '$lib/components/ui/Carousel.svelte';
	import { get, derived } from 'svelte/store';
	import { categoriesStore } from '$lib/stores/categories.store';
	import { sessionStore } from '$lib/stores/session.store';
	import { getCategoryIcon } from '$lib/utils/category-icons';
	import classNames from 'classnames';

	let drawerOpen = $state(false);
	let editMode = $state(false);
	let selectedExpense = $state<ExpenseRow | null>(null);
	const today = new Date();
	let selectedDate = $state(toDateOnlyStr(today));
	let showDatePicker = $state(false);
	let items = $state<ExpenseRow[]>([]);
	let loading = $state(false);
	let amount = $state('');
	let categoryId = $state('');
	let scope = $state<'personal' | 'household'>('personal');
	let content = $state('');
	let calcResetKey = $state(0);

	// 分類資料
	const categoryItems = categoriesStore.items;
	const expenseOptions = categoriesStore.expenseOptions; // [{ value, label }]
	// 依據 id 取得 icon（由名稱映射而來）
	const categoryIconMap = derived(categoryItems, ($items) => {
		const entries = $items.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});
	// 轉為卡片資料並分頁（每頁 8 個）
	type CategoryCard = { id: string; name: string; icon: string };
	const categoryCards = derived([expenseOptions, categoryIconMap], ([$opts, $icons]) =>
		$opts.map((o) => ({ id: o.value, name: o.label, icon: $icons[o.value] }))
	);
	const categoryPages = derived(categoryCards, ($cards): CategoryCard[][] => {
		const pageSize = 8;
		const pages: CategoryCard[][] = [];
		for (let i = 0; i < $cards.length; i += pageSize) {
			pages.push($cards.slice(i, i + pageSize));
		}
		return pages;
	});

	$effect(() => {
		// run on init and whenever selectedDate changes
		void loadDayFor(selectedDate);
	});

	async function loadDayFor(dateStr: string) {
		loading = true;
		try {
			const { from, to } = dayBoundsISO(dateStr);
			const page = await listExpenses({ from, to, limit: 500, settled: 'all' });
			items = page.items;
		} finally {
			loading = false;
		}
	}
	function toDateOnlyStr(d: Date) {
		const y = d.getFullYear(),
			m = String(d.getMonth() + 1).padStart(2, '0'),
			da = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${da}`;
	}
	function dayBoundsISO(dateStr: string) {
		const [y, m, d] = dateStr.split('-').map(Number);
		const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)),
			end = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
		return { from: start.toISOString(), to: end.toISOString() };
	}
	function isToday(dateStr: string) {
		return dateStr === toDateOnlyStr(today);
	}
	function shiftDay(delta: number) {
		if (delta > 0 && isToday(selectedDate)) {
			return;
		}
		const [y, m, d] = selectedDate.split('-').map(Number);
		const next = toDateOnlyStr(new Date(y, m - 1, d + delta));
		if (delta > 0 && next > toDateOnlyStr(today)) {
			return;
		}
		selectedDate = next;
	}

	function openCreate() {
		editMode = false;
		selectedExpense = null;
		amount = '';
		categoryId = '';
		scope = 'personal';
		content = '';
		// 重置計算機狀態
		calcResetKey++;
		drawerOpen = true;
	}

	function openEdit(e: ExpenseRow) {
		editMode = true;
		selectedExpense = e;
		amount = String(e.amount);
		categoryId = e.category_id ?? '';
		scope = e.scope;
		content = e.note;
		// 重置計算機狀態
		calcResetKey++;
		drawerOpen = true;
	}

	function validateForm() {
		if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
			return '請輸入有效金額';
		}
		if (!categoryId) {
			return '請選擇類別';
		}
		if (!content.trim()) {
			return '請輸入帳目內容';
		}
		return '';
	}
	async function submitForm() {
		const err = validateForm();
		if (err) {
			alert(err);
			return;
		}
		const now = new Date();
		const [y, m, d] = selectedDate.split('-').map(Number);
		const tsLocal = new Date(
			y,
			m - 1,
			d,
			now.getHours(),
			now.getMinutes(),
			now.getSeconds(),
			now.getMilliseconds()
		);
		const userEmail = get(sessionStore.user)?.email ?? '';
		const payload: UpsertExpenseInput = {
			id: editMode ? selectedExpense?.id : undefined,
			note: content,
			amount: Number(amount),
			currency: 'TWD',
			ts: tsLocal.toISOString(),
			payer_email: userEmail,
			scope,
			shares_json: {},
			category_id: categoryId,
		};
		await upsertExpense(payload);
		drawerOpen = false;
		await loadDayFor(selectedDate);
	}

	let startX = 0,
		dx = 0;
	const SWIPE = 60;
	function onTouchStart(e: TouchEvent) {
		startX = e.touches[0].clientX;
		dx = 0;
	}
	function onTouchMove(e: TouchEvent) {
		dx = e.touches[0].clientX - startX;
	}
	function onTouchEnd() {
		if (dx < -SWIPE) {
			shiftDay(+1);
		}
		if (dx > SWIPE) {
			shiftDay(-1);
		}
		startX = 0;
		dx = 0;
	}
</script>

<section
	class="card p-4"
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
>
	<div class="flex items-center justify-center">
		<button class="px-2 py-1" onclick={() => shiftDay(-1)}>◀</button>
		<button
			class="px-3 py-1 rounded-md hover:bg-black/5"
			onclick={() => (showDatePicker = true)}
			>{isToday(selectedDate) ? 'Today' : selectedDate}</button
		>
		<button
			class="px-2 py-1 disabled:opacity-40"
			disabled={isToday(selectedDate)}
			onclick={() => shiftDay(+1)}
		>
			▶
		</button>
	</div>
	{#if loading}
		<p class="mt-3 opacity-70">載入中…</p>
	{:else if items.length === 0}
		<div class="mt-3">
			<button class="btn btn-primary w-full" onclick={openCreate}>輸入今日第一筆記帳</button>
		</div>
	{:else}
		<ul class="mt-3 divide-y divide-black/5">
			{#each items as e (e.id)}
				<li class="py-2 flex items-center gap-3">
					<div class="w-8 h-8 grid place-items-center rounded-lg bg-[var(--c-bg)]">
						{#if $categoryIconMap[e.category_id ?? '']}
							<Icon
								icon={$categoryIconMap[e.category_id ?? '']}
								width={16}
								height={16}
							/>
						{:else}
							💸
						{/if}
					</div>
					<div class="flex-1 min-w-0">
						<div class="text-sm font-medium truncate">{e.note}</div>
						<div class="text-xs opacity-70">{e.scope === 'household' ? 'h' : 'p'}</div>
					</div>
					<div class="text-right tabular-nums font-semibold">{e.amount}</div>
					<button
						class="ml-2 opacity-60 hover:opacity-100"
						aria-label="Edit"
						onclick={() => openEdit(e)}
					>
						✏️
					</button>
				</li>
			{/each}
		</ul>
		<div class="mt-3"><button class="btn w-full" onclick={openCreate}>新增項目</button></div>
	{/if}
</section>

<Dialog.Root bind:open={showDatePicker}>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 bg-black/40" />
		<Dialog.Content class="card fixed inset-x-6 top-[25vh] p-5">
			<Dialog.Title class="font-semibold">選擇日期</Dialog.Title>
			<input
				type="date"
				bind:value={selectedDate}
				class="mt-2 w-full"
				max={toDateOnlyStr(today)}
			/>
			<div class="mt-4 flex justify-end">
				<button class="btn btn-primary" onclick={() => (showDatePicker = false)}
					>完成</button
				>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<SwipeDrawer bind:open={drawerOpen} title={editMode ? '編輯項目' : '新增項目'}>
	<label class="block text-sm mb-1" for="date-input">日期</label>
	<input
		id="date-input"
		type="date"
		class="w-full mb-3 p-3 rounded-lg border border-black/10"
		bind:value={selectedDate}
		max={toDateOnlyStr(today)}
	/>

	<label class="block text-sm mb-1" for="amount-input">金額</label>
	<input
		id="amount-input"
		class="w-full mb-3 p-3 rounded-lg border border-black/10"
		inputmode="decimal"
		bind:value={amount}
		placeholder="0"
	/>

	<div class="block text-sm mb-1">類別</div>
	<!-- Category Grid + Carousel -->
	{#if $expenseOptions.length > 0}
		{#snippet children(page, i)}
			<div class="grid grid-cols-4 gap-3" aria-label={`Category page ${i + 1}`}>
				{#each page as cat (cat.id)}
					<button
						type="button"
						class={classNames(
							'flex flex-col items-center gap-1 p-2 rounded-lg shadow-md',
							'bg-white data-[selected=true]:bg-[var(--c-bg)]',
						)}
						data-selected={categoryId === cat.id}
						onclick={() => (categoryId = cat.id)}
					>
						<div
							class={classNames(
								'size-12 grid place-items-center rounded-xl',
								'text-[var(--c-accent)]'
							)}
							data-selected={categoryId === cat.id}
						>
							<Icon icon={cat.icon} width={32} height={32} />
						</div>
						<div
							class={classNames('text-xs truncate max-w-16', 'text-[var(--c-accent)]')}
							data-selected={categoryId === cat.id}
						>
							{cat.name}
						</div>
					</button>
				{/each}
			</div>
		{/snippet}

		<Carousel
			items={$categoryPages}
			loop={false}
			slidesPerView={1}
			gap={12}
			showDots={true}
			showArrows={false}
			itemLabel="Category Page"
			carouselSlideClassName="p-2"
			{children}
		/>
	{:else}
		<p class="mb-3 opacity-60">載入類別中…</p>
	{/if}

	<fieldset class="mb-3">
		<legend class="text-sm mb-1">Scope</legend>
		<div class="flex gap-2">
			<label
				class="flex items-center gap-2 p-2 rounded-lg border border-black/10 cursor-pointer"
				class:selected={scope === 'personal'}
				><input type="radio" name="scope" value="personal" bind:group={scope} /> 個人</label
			><label
				class="flex items-center gap-2 p-2 rounded-lg border border-black/10 cursor-pointer"
				class:selected={scope === 'household'}
				><input type="radio" name="scope" value="household" bind:group={scope} /> 家庭</label
			>
		</div>
	</fieldset>
	<label class="block text-sm mb-1" for="content-input">帳目內容</label>
	<input
		id="content-input"
		class="w-full mb-3 p-3 rounded-lg border border-black/10"
		bind:value={content}
		placeholder="例如：午餐便當"
	/>
	<button class="btn btn-primary w-full mb-3" onclick={submitForm}
		>{editMode ? '更新' : '新增'}</button
	>
	{#key calcResetKey}
		<Calculator bind:amount />
	{/key}
</SwipeDrawer>

<style>
</style>
