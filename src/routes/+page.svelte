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
	// 新增：家庭成員來源與 shares 型別
	import { appSettingStore } from '$lib/stores/appSetting.store';
	import type { ShareEntry } from '$lib/types/expense';
	import { taiwanDayBoundsISO } from '$lib/utils/dates';

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
	// 新增：是否結清狀態（依 scope 控制）
	let isSettled = $state<boolean>(false);
	// 新增：分帳輸入（email -> amount string）
	let shares = $state<Record<string, string>>({});

	// 分類資料
	const categoryItems = categoriesStore.items;
	const expenseOptions = categoriesStore.expenseOptions; // [{ value, label }]
	// 依據 id 取得 icon（由名稱映射而來）
	const categoryIconMap = derived(categoryItems, (itemsArr) => {
		const entries = itemsArr.map((c) => [c.id, getCategoryIcon(c.name)] as const);
		return Object.fromEntries(entries) as Record<string, string>;
	});
	// 轉為卡片資料並分頁（每頁 8 個）
	type CategoryCard = { id: string; name: string; icon: string };
	const categoryCards = derived([expenseOptions, categoryIconMap], ([opts, iconMap]) =>
		opts.map((o) => ({ id: o.value, name: o.label, icon: iconMap[o.value] }))
	);
	const categoryPages = derived(categoryCards, (cards): CategoryCard[][] => {
		const pageSize = 8;
		const pages: CategoryCard[][] = [];
		for (let i = 0; i < cards.length; i += pageSize) {
			pages.push(cards.slice(i, i + pageSize));
		}
		return pages;
	});

	// 新增：載入 app 設定（家庭成員）
	const allowedUsers = appSettingStore.users; // string[] emails
	$effect(() => {
		void appSettingStore.load();
	});
	// 新增：email → 顯示名稱 mapping
	const userLabelMap = derived([allowedUsers, sessionStore.user], ([allowed, me]) => {
		const map: Record<string, string> = {};
		for (const email of allowed) {
			if (me?.email === email && me.display_name) {
				map[email] = me.display_name;
			} else {
				map[email] = email.split('@')[0]; // 預設用 email 前綴
			}
		}
		return map;
	});
	// 新增：shares 合計與驗證
	const sharesTotal = $derived(
		Object.values(shares).reduce((a, v) => a + (Number(v) || 0), 0)
	);
	const sharesValid = $derived(Number(amount || 0) === sharesTotal);

	$effect(() => {
		// run on init and whenever selectedDate changes
		void loadDayFor(selectedDate);
	});

	// 新增：當 scope/成員變動時初始化 shares 的 key（不覆蓋已填值）
	$effect(() => {
		if (scope === 'household' && $allowedUsers.length > 0) {
			for (const email of $allowedUsers) {
				if (!(email in shares)) {
					shares[email] = '';
				}
			}
		}
		if (scope === 'personal') {
			shares = {};
		}
		// 依 scope 設定 isSettled 預設值與限制
		if (scope === 'personal') {
			// 個人：強制為已結清並鎖定
			isSettled = true;
		} else {
			// 家庭：預設 false（僅在新增時套用，不覆蓋編輯中的既有值）
			if (!editMode) {
				isSettled = false;
			}
		}
	});

	async function loadDayFor(dateStr: string) {
		loading = true;
		try {
			const { from, to } = taiwanDayBoundsISO(dateStr);
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
		shares = {}; // 清空分帳
		// 新增：依個人預設為已結清
		isSettled = true;
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
		// 新增：載入既有 is_settled 狀態
		isSettled = e.is_settled;
		// 初始化分帳
		if (e.scope === 'household' && e.shares_json) {
			shares = Object.fromEntries(
				Object.entries(e.shares_json).map(([k, v]) => [k, String(v)])
			);
		} else {
			shares = {};
		}
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
		if (scope === 'household') {
			if (!sharesValid) {
				return '分帳總和需等於金額';
			}
			const hasAny = Object.values(shares).some((v) => Number(v) > 0);
			if (!hasAny) {
				return '請至少分配一位成員的分帳金額';
			}
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
		const userEmail = get(sessionStore.user)?.email ?? '';
		// 組裝 shares_json
		let shares_json: ShareEntry;
		if (scope === 'personal') {
			shares_json = { [userEmail]: Number(amount) };
		} else {
			const entries = Object.entries(shares)
				.map(([email, v]) => [email, Number(v) || 0] as const)
				.filter(([, val]) => val > 0);
			const sum = entries.reduce((a, [, v]) => a + v, 0);
			if (sum !== Number(amount)) {
				alert('分帳總和需等於金額');
				return;
			}
			shares_json = Object.fromEntries(entries);
		}
		const payload: UpsertExpenseInput = {
			id: editMode ? selectedExpense?.id : undefined,
			note: content,
			amount: Number(amount),
			currency: 'TWD',
			payer_email: userEmail,
			scope,
			shares_json,
			category_id: categoryId,
			updated_at: editMode ? now.toISOString() : undefined,
			// 新增：傳入是否結清
			is_settled: scope === 'personal' ? true : isSettled,
		};
		console.log('Would submit payload:', payload);
		console.log('selected date:', selectedDate);
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
		{#snippet children(page: unknown, i: number)}
		<div class="grid grid-cols-4 gap-3" aria-label={`Category page ${i + 1}`}>
			{#each (page as CategoryCard[]) as cat (cat.id)}
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

	<!-- 新增：是否結清 -->
	<div class="mb-3 flex items-center gap-2">
		<input
			id="settled-input"
			type="checkbox"
			bind:checked={isSettled}
			disabled={scope === 'personal'}
			class="size-4"
		/>
		<label for="settled-input" class="text-sm">
			已結清
		</label>
	</div>

	{#if scope === 'household'}
		<div class="mb-3">
			<div class="text-sm mb-1">分帳</div>
			{#if $allowedUsers.length === 0}
				<p class="opacity-60 text-sm">尚未設定家庭成員</p>
			{:else}
				<div class="flex flex-col gap-2">
					{#each $allowedUsers as email (email)}
						<div class="flex items-center gap-2">
							<div class="flex-1 text-sm truncate">{$userLabelMap[email] ?? email}</div>
							<input
								class="w-28 p-2 rounded-lg border border-black/10 text-right"
								inputmode="decimal"
								bind:value={shares[email]}
								placeholder="0"
							/>
						</div>
					{/each}
				</div>
				<div class="mt-2 text-xs">
					合計：{sharesTotal} / 金額：{Number(amount || 0)}
					{#if amount && !sharesValid}
						<span class="text-red-600 ml-2">不相符</span>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

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
