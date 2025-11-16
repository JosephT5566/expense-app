<script lang="ts">
	export type CategoryOption = { value: string; label: string };
	import { type ExpenseRow, NewExpense } from '$lib/types/expense';
	import type { UpsertExpenseInput } from '$lib/data/expenses.fetcher';
	import { onMount } from 'svelte';
	import type { ShareEntry } from '$lib/types/expense';
	import { upsertExpense, deleteExpense } from '$lib/data/expenses.fetcher';
	import Icon from '@iconify/svelte';
	import classNames from 'classnames';
	import { allowedUserInfo, allowedUsers } from '$lib/stores/appSetting.store';
	import { expenseOptions, categoryIconMap } from '$lib/stores/categories.store';
	import { getExpenseById, upsertOne, deleteOne } from '$lib/stores/expenses.store';
	import { user as currentUser } from '$lib/stores/session.store';
	import Calculator from '$lib/components/ui/Calculator.svelte';
	import Carousel from '$lib/components/ui/Carousel.svelte';
	import { derived } from 'svelte/store';
	import { toTaiwanDateString } from '$lib/utils/dates';
	import { withMinimumLoading, withTemporaryFlag } from '$lib/utils/loading';
	import Logger from '$lib/utils/logger';
	type CategoryCard = { id: string; name: string; icon: string };

	let {
		expenseId = '',
		editMode = false,
		selectedDate = '',
		onSubmitFinish,
	}: {
		expenseId?: string;
		editMode?: boolean;
		selectedDate: string;
		onSubmitFinish?: () => void;
	} = $props();

	let expenseData = $state(
		expenseId ? getExpenseById(expenseId) : Object.assign({}, new NewExpense()) // transfer a Class to an Object.
	);

	const today = new Date();
	const FINISHED_DURATION_MS = 1500;

	let calculatorModal: HTMLDialogElement | null = $state(null);
	let calculatorRef = $state<ReturnType<typeof Calculator>>();

	// handle and update shares state
	let shares = $state(
		expenseData.scope === 'personal' || !expenseData?.shares_json ? {} : expenseData.shares_json
	);
	$effect(() => {
		if (expenseData.scope === 'personal' || !expenseData?.shares_json) {
			shares = {};
		}
		shares = expenseData.shares_json;
	});

	// 新增：shares 合計與驗證
	const sharesTotal = $derived(Object.values(shares).reduce((a, v) => a + (Number(v) || 0), 0));
	const sharesValid = $derived(Number(expenseData.amount || 0) === sharesTotal);

	// 轉為卡片資料並分頁（每頁 8 個）
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

	onMount(() => {
		if (!calculatorModal) {
			return;
		}

		calculatorModal.addEventListener('click', (e) => {
			if (e.target === calculatorModal) {
				e.stopPropagation();
				(calculatorModal as HTMLDialogElement).close();
			}
		});
	});

	// Check if the expense data has been updated
	let previousExpense = $state.snapshot(expenseData);
	let isUpdated = $state(false);
	$effect(() => {
		const currentSnapshot = $state.snapshot(expenseData);
		if (JSON.stringify(previousExpense) !== JSON.stringify(currentSnapshot)) {
			Logger.log('data changed');
			isUpdated = true;
			// resetFinished();
			previousExpense = currentSnapshot;
			// Logger.log('expenseData', $state.snapshot(expenseData));
		}
	});
	$effect(() => {
		if (selectedDate !== toTaiwanDateString(expenseData.ts)) {
			isUpdated = true;
			// resetFinished();
		}
	});

	// 新增：當 scope/成員變動時初始化 shares 的 key（不覆蓋已填值）
	$effect(() => {
		if (expenseData.scope === 'household' && $allowedUsers.length > 0) {
			for (const email of $allowedUsers) {
				if (!(email in shares)) {
					shares[email] = 0;
				}
			}
		}
		if (expenseData.scope === 'personal') {
			shares = {};
		}
		// 依 scope 設定 isSettled 預設值與限制
		if (expenseData.scope === 'personal') {
			// 個人：強制為已結清並鎖定
			expenseData.is_settled = true;
		} else {
			// 家庭：預設 false（僅在新增時套用，不覆蓋編輯中的既有值）
			if (!editMode) {
				expenseData.is_settled = false;
			}
		}
	});

	let isLoading = $state(false);
	let loadingAction = $state<'submit' | 'delete' | null>(null);
	let isFinished = $state(false);
	let finishedAction = $state<'submit' | 'delete' | null>(null);
	let clearFinishedTimeout: (() => void) | null = null;

	function resetFinished() {
		if (clearFinishedTimeout) {
			clearFinishedTimeout();
			clearFinishedTimeout = null;
		} else if (isFinished) {
			isFinished = false;
		}
		finishedAction = null;
	}

	function markFinished(action: 'submit' | 'delete') {
		resetFinished();
		finishedAction = action;
		clearFinishedTimeout = withTemporaryFlag(
			(value) => {
				isFinished = value;
				if (!value) {
					finishedAction = null;
					clearFinishedTimeout = null;
				}
			},
			FINISHED_DURATION_MS
		);
	}

	function validateForm() {
		if (
			!expenseData.amount ||
			Number.isNaN(Number(expenseData.amount)) ||
			Number(expenseData.amount) <= 0
		) {
			return '請輸入有效金額';
		}
		if (!expenseData.category_id) {
			return '請選擇類別';
		}
		if (!expenseData.note.trim()) {
			return '請輸入帳目內容';
		}
		if (expenseData?.scope === 'household') {
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

	async function handleSubmit(e: Event) {
		e.preventDefault(); // prevent page reload
		resetFinished();

		const err = validateForm();
		if (err) {
			alert(err);
			return;
		}

		const now = new Date();
		const userEmail = $currentUser?.email ?? '';

		// 組裝 shares_json
		let shares_json: ShareEntry;
		if (expenseData.scope === 'personal') {
			shares_json = { [userEmail]: Number(expenseData.amount) } as ShareEntry;
		} else {
			shares_json = $state.snapshot(shares);
		}

		const originTs = toTaiwanDateString((expenseData as ExpenseRow).ts);
		const payload: UpsertExpenseInput = {
			id: editMode ? expenseId : undefined,
			note: expenseData.note,
			amount: Number(expenseData.amount),
			currency: 'TWD',
			payer_email:
				expenseData.scope === 'personal' ? userEmail : expenseData.payer_email || userEmail,
			scope: expenseData.scope,
			shares_json,
			category_id: expenseData.category_id || '',
			updated_at: editMode ? now.toISOString() : undefined,
			// 新增：傳入是否結清
			is_settled: expenseData.is_settled,
			ts: selectedDate !== originTs ? new Date(selectedDate).toISOString() : undefined,
		};
		Logger.log('Would submit payload:', payload);

		loadingAction = 'submit';
		try {
			await withMinimumLoading(
				async () => {
					const savedExpense = await upsertExpense(payload);
					// 更新到全域 expenses store
					upsertOne(savedExpense);
				},
				(value) => (isLoading = value)
			);
			markFinished('submit');
		} catch (error) {
			Logger.error('Upsert expense error:', error);
		} finally {
			loadingAction = null;
			onSubmitFinish?.();
		}
	}

	async function handleDelete(expenseId: string) {
		const confirmDelete = confirm('確定要刪除嗎？');
		if (!confirmDelete) {
			return;
		}

		resetFinished();
		loadingAction = 'delete';
		try {
			await withMinimumLoading(
				async () => {
					const { status } = await deleteExpense(expenseId);
					if (status !== 204) {
						throw new Error(`Failed to delete expense, status code: ${status}`);
					}
				},
				(value) => (isLoading = value)
			);

			deleteOne(expenseId);
			markFinished('delete');
			alert('刪除完成');
		} catch (error) {
			alert('刪除失敗，請稍後再試。');
			Logger.error('Delete expense error:', error);
			return;
		} finally {
			loadingAction = null;
			onSubmitFinish?.();
		}
	}
</script>

<dialog
	bind:this={calculatorModal}
	id="calculator_modal"
	class="modal"
	closedby="any"
	onclose={() => {
		if (calculatorRef) {
			calculatorRef.resetCal();
		}
	}}
>
	<div class="modal-box w-11/12 max-w-5xl">
		<Calculator bind:this={calculatorRef} bind:amountNum={expenseData.amount} />
	</div>
</dialog>

<form class="flex flex-col gap-3" onsubmit={handleSubmit}>
	<div>
		<label class="block text-sm mb-1 font-semibold" for="date-input">日期</label>
		<input
			id="date-input"
			type="date"
			class="w-full p-3 rounded-lg border border-black/10 disabled:text-[var(--c-muted)]"
			bind:value={selectedDate}
			disabled={!editMode}
			max={toTaiwanDateString(today)}
		/>
	</div>

	<div>
		<label class="block text-sm mb-1 font-semibold" for="amount-input">金額</label>
		<div class="join w-full rounded-lg relative">
			<input
				class="w-full p-3 rounded-lg border border-black/10"
				id="amount-input"
				inputmode="decimal"
				type="number"
				value={expenseData.amount === 0 ? '' : expenseData.amount}
				oninput={(e) => {
					const target = e.target as HTMLInputElement;
					expenseData.amount = Number(target.value);
				}}
				placeholder="Enter a number"
			/>
			<button
				type="button"
				class="btn btn-primary h-full join-item absolute right-0 rounded-l-[0px]!"
				onclick={() => {
					calculatorModal?.showModal();
				}}
			>
				<Icon icon="solar:calculator-bold-duotone" width="24" height="24" />
			</button>
		</div>
	</div>

	<fieldset class="fieldset">
		<legend class="fieldset-legend text-sm">類別</legend>
		{#if $expenseOptions.length > 0}
			{#snippet children(page: unknown, i: number)}
				<div class="grid grid-cols-4 gap-3" aria-label={`Category page ${i + 1}`}>
					{#each page as CategoryCard[] as cat (cat.id)}
						<button
							type="button"
							class={classNames(
								'flex flex-col items-center gap-1 p-2 rounded-lg shadow-md',
								'bg-white data-[selected=true]:bg-[var(--c-bg)]'
							)}
							data-selected={expenseData.category_id === cat.id}
							onclick={() => (expenseData.category_id = cat.id)}
						>
							<div
								class={classNames(
									'size-12 grid place-items-center rounded-xl',
									'text-[var(--c-accent)]'
								)}
								data-selected={expenseData.category_id === cat.id}
							>
								<Icon icon={cat.icon} width={32} height={32} />
							</div>
							<div
								class={classNames(
									'text-xs truncate max-w-16',
									'text-[var(--c-accent)]'
								)}
								data-selected={expenseData.category_id === cat.id}
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
			<p class="opacity-60">載入類別中…</p>
		{/if}
	</fieldset>

	<fieldset class="fieldset">
		<legend class="fieldset-legend text-sm">類別</legend>
		<div class="flex gap-2 mb-2">
			<label
				class="flex items-center gap-2 p-2 rounded-lg border border-black/10 cursor-pointer"
				class:selected={expenseData?.scope === 'personal'}
				><input type="radio" name="scope" value="personal" bind:group={expenseData.scope} />
				個人</label
			><label
				class="flex items-center gap-2 p-2 rounded-lg border border-black/10 cursor-pointer"
				class:selected={expenseData?.scope === 'household'}
				><input
					type="radio"
					name="scope"
					value="household"
					bind:group={expenseData.scope}
				/>
				家庭</label
			>
		</div>
		{#if expenseData?.scope === 'household'}
			<fieldset class="fieldset">
				<legend class="fieldset-legend text-sm">付款人</legend>
				<select class="select w-full" bind:value={expenseData.payer_email}>
					{#each $allowedUsers as email (email)}
						<option value={email} selected={email === expenseData.payer_email}>
							{$allowedUserInfo[email].name ?? email}
						</option>
					{/each}
				</select>
			</fieldset>
			<fieldset
				class="fieldset bg-base-200 border-base-300 rounded-box w-full border px-4 pt-0 pb-2"
			>
				<legend class="fieldset-legend text-sm">分帳</legend>
				{#if $allowedUsers.length === 0}
					<p class="opacity-60 text-sm">尚未設定家庭成員</p>
				{:else}
					<div class="flex flex-col gap-2">
						{#each $allowedUsers as email (email)}
							<div class="flex items-center gap-2">
								<div class="flex-1 text-sm truncate">
									{$allowedUserInfo[email].name ?? email}
								</div>
								<input
									class="p-2 rounded-lg border border-black/10 text-right"
									name={email}
									type="number"
									inputmode="decimal"
									value={shares[email] == 0 ? '' : shares[email]}
									oninput={(e) => {
										const target = e.target as HTMLInputElement;
										shares[email] = Number(target.value);
									}}
									placeholder="Enter a number"
								/>
							</div>
						{/each}
					</div>
					<div class="mt-2 text-xs">
						合計：{sharesTotal} / 金額：{expenseData.amount}
						{#if expenseData.amount && !sharesValid}
							<span class="text-red-600 ml-2">不相符</span>
						{/if}
					</div>
				{/if}
			</fieldset>

			<div class="flex items-center gap-2 mt-2">
				<input
					id="settled-input"
					type="checkbox"
					bind:checked={expenseData.is_settled}
					disabled={expenseData?.scope !== 'household'}
					class="size-4"
				/>
				<label for="settled-input" class="text-sm"> 已結清 </label>
			</div>
		{/if}
	</fieldset>

	<label class="block text-sm mb-1 font-semibold" for="content-input">帳目內容</label>
	<input
		id="content-input"
		class="w-full p-3 rounded-lg border border-black/10"
		bind:value={expenseData.note}
		placeholder="例如：午餐便當"
	/>

	<button
		type="submit"
		class="btn btn-primary w-full"
		disabled={!isUpdated || isLoading || (isFinished && finishedAction === 'submit')}
	>
		{#if isLoading && loadingAction === 'submit'}
			<Icon icon="svg-spinners:90-ring-with-bg" width="20" height="20" class="text-base-100" />
		{:else if isFinished && finishedAction === 'submit'}
			Done
		{:else}
			{editMode ? '更新' : '新增'}
		{/if}
	</button>
</form>
{#if editMode}
	<button
		class="btn btn-primary w-full mt-3"
		disabled={isLoading || (isFinished && finishedAction === 'delete')}
		onclick={() => {
			handleDelete(expenseId);
		}}
	>
		{#if isLoading && loadingAction === 'delete'}
			<Icon icon="svg-spinners:90-ring-with-bg" width="20" height="20" class="text-base-100" />
		{:else if isFinished && finishedAction === 'delete'}
			Done
		{:else}
			刪除
		{/if}
	</button>
{/if}

<style>
	form :global(.select) {
		min-height: 3rem;
	}
</style>
