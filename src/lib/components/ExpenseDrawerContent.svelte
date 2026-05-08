<script lang="ts">
	export type CategoryOption = { value: string; label: string };
	import { type ExpenseRow, NewExpense } from '$lib/types/expense';
	import type { UpsertExpenseInput } from '$lib/data/expenses.fetcher';
	import type { ShareEntry } from '$lib/types/expense';
	import { upsertExpense, deleteExpense } from '$lib/data/expenses.fetcher';
	import Icon from '@iconify/svelte';
	import classNames from 'classnames';
	import { allowedUserInfo, allowedUsers } from '$lib/stores/appSetting.store';
	import { expenseOptions, categoryIconMap } from '$lib/stores/categories.store';
	import { getExpenseById, upsertOne, deleteOne } from '$lib/stores/expenses.store';
	import { user as currentUser } from '$lib/stores/session.store';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import Calculator from '$lib/components/ui/Calculator.svelte';
	import Carousel from '$lib/components/ui/Carousel.svelte';
	import { derived } from 'svelte/store';
	import { toTaiwanDateString } from '$lib/utils/dates';
	import { useAsyncAction } from '$lib/utils/loading';
	import Logger from '$lib/utils/logger';
	import { Label } from '$lib/components/shadcn/label';
	import { Input } from '$lib/components/shadcn/input';
	import { Button } from '$lib/components/shadcn/button';
	import { ButtonGroup } from '$lib/components/shadcn/button-group';
	import { Checkbox } from '$lib/components/shadcn/checkbox';
	import * as RadioGroup from '$lib/components/shadcn/radio-group';
	import * as Select from '$lib/components/shadcn/select';

	type CategoryCard = { id: string; name: string; icon: string };

	let {
		expenseId = '',
		editMode = false,
		selectedDate: selectedDateProp = '',
		onSubmitFinish,
	}: {
		expenseId?: string;
		editMode?: boolean;
		selectedDate?: string;
		onSubmitFinish?: () => void;
	} = $props();

	let expenseData = $state(
		expenseId ? getExpenseById(expenseId) : Object.assign({}, new NewExpense()), // transfer a Class to an Object.
	);

	let selectedDate = $derived(
		selectedDateProp || (expenseData.ts ? toTaiwanDateString(expenseData.ts) : ''),
	);

	const today = new Date();
	// const LOADING_MIN_DURATION_MS = 400;
	// const FINISHED_DURATION_MS = 1500;

	let calculatorDialogOpen = $state(false);
	let calculatorRef = $state<ReturnType<typeof Calculator>>();

	// handle and update shares state
	let shares = $state(
		expenseData.scope === 'personal' || !expenseData?.shares_json
			? {}
			: expenseData.shares_json,
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
		opts.map((o) => ({ id: o.value, name: o.label, icon: iconMap[o.value] })),
	);
	const categoryPages = derived(categoryCards, (cards): CategoryCard[][] => {
		const pageSize = 8;
		const pages: CategoryCard[][] = [];
		for (let i = 0; i < cards.length; i += pageSize) {
			pages.push(cards.slice(i, i + pageSize));
		}
		return pages;
	});

	// Check if the expense data has been updated
	let previousExpense = $state.snapshot(expenseData);
	let isUpdated = $state(false);
	$effect(() => {
		if (JSON.stringify(previousExpense) !== JSON.stringify(expenseData)) {
			Logger.log('data changed');
			isUpdated = true;
			// Logger.log('expenseData', $state.snapshot(expenseData));
		}
	});
	$effect(() => {
		if (selectedDate !== toTaiwanDateString(expenseData.ts)) {
			isUpdated = true;
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

	const { run: submitRun, isLoading: submitIsLoading, isDone: submitIsDone } = useAsyncAction();
	const { run: deleteRun, isLoading: deleteIsLoading, isDone: deleteIsDone } = useAsyncAction();

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

		try {
			await submitRun(async () => {
				Logger.log('Submitting expense...');
				const savedExpense = await upsertExpense(payload);
				// 更新到全域 expenses store
				upsertOne(savedExpense);
			});
		} catch (error) {
			Logger.error('Upsert expense error:', error);
			return;
		} finally {
			onSubmitFinish?.();
		}
	}

	async function handleDelete(expenseId: string) {
		const confirmDelete = confirm('確定要刪除嗎？');
		if (!confirmDelete) {
			return;
		}

		try {
			await deleteRun(async () => {
				const { status } = await deleteExpense(expenseId);
				if (status !== 204) {
					throw new Error(`Failed to delete expense, status code: ${status}`);
				}
				deleteOne(expenseId);
			});
		} catch (error) {
			// alert('刪除失敗，請稍後再試。'); // TODO: Set a toast notification
			Logger.error('Delete expense error:', error);
			return;
		} finally {
			onSubmitFinish?.();
		}
	}
</script>

<Dialog.Root bind:open={calculatorDialogOpen}>
	<Dialog.Content
		class="w-11/12 max-w-5xl"
		onCloseAutoFocus={() => {
			if (calculatorRef) {
				calculatorRef.resetCal();
			}
		}}
	>
		<Calculator bind:this={calculatorRef} bind:amountNum={expenseData.amount} />
	</Dialog.Content>
</Dialog.Root>

<form class="flex flex-col gap-4" onsubmit={handleSubmit}>
	<div class="grid gap-2">
		<Label for="date-input">日期</Label>
		<Input
			id="date-input"
			type="date"
			bind:value={selectedDate}
			disabled={!editMode}
			max={toTaiwanDateString(today)}
		/>
	</div>

	<div class="grid gap-2">
		<Label for="amount-input">金額</Label>
		<div class="relative">
			<ButtonGroup class="w-full">
				<Input
					id="amount-input"
					type="number"
					inputmode="decimal"
					placeholder="輸入金額"
					value={expenseData.amount === 0 ? '' : expenseData.amount}
					oninput={(e) => {
						const target = e.target as HTMLInputElement;
						expenseData.amount = Number(target.value);
					}}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					onclick={() => {
						calculatorDialogOpen = true;
					}}
				>
					<Icon icon="solar:calculator-bold-duotone" width="20" height="20" />
				</Button>
			</ButtonGroup>
		</div>
	</div>

	<fieldset>
		<legend class="text-sm font-semibold mb-2">類別</legend>
		{#if $expenseOptions.length > 0}
			{#snippet children(page: unknown, i: number)}
				<div class="grid grid-cols-4 gap-3" aria-label={`Category page ${i + 1}`}>
					{#each page as CategoryCard[] as cat (cat.id)}
						<Button
							type="button"
							variant="outline"
							class={classNames(
								'h-auto flex flex-col gap-1 p-2',
								'bg-white text-secondary shadow-sm',
								'data-[selected=true]:text-primary data-[selected=true]:ring-2',
							)}
							data-selected={expenseData.category_id === cat.id}
							onclick={() => (expenseData.category_id = cat.id)}
						>
							<div class="size-12 grid place-items-center rounded-lg">
								<Icon icon={cat.icon} class="size-8" width={32} height={32} />
							</div>
							<div class="text-xs truncate max-w-16">{cat.name}</div>
						</Button>
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

	<fieldset class="grid gap-2">
		<legend class="text-sm font-semibold">範圍</legend>
		<RadioGroup.Root bind:value={expenseData.scope}>
			<div class="flex gap-2">
				<Label
					for="scope-personal"
					class="flex items-center gap-2 p-2 rounded-lg border cursor-pointer flex-1 justify-center {expenseData.scope ===
					'personal'
						? 'bg-primary text-primary-foreground'
						: ''}"
				>
					<RadioGroup.Item value="personal" id="scope-personal" />
					個人
				</Label>
				<Label
					for="scope-household"
					class="flex items-center gap-2 p-2 rounded-lg border cursor-pointer flex-1 justify-center {expenseData.scope ===
					'household'
						? 'bg-primary text-primary-foreground'
						: ''}"
				>
					<RadioGroup.Item value="household" id="scope-household" />
					家庭
				</Label>
			</div>
		</RadioGroup.Root>

		{#if expenseData?.scope === 'household'}
			<div class="grid gap-4 mt-2">
				<div class="grid gap-2">
					<Label>付款人</Label>
					<Select.Root type="single" bind:value={expenseData.payer_email}>
						<Select.Trigger class="w-full">
							<Select.Value placeholder="選擇付款人" />
						</Select.Trigger>
						<Select.Content>
							{#each $allowedUsers as email (email)}
								<Select.Item value={email}
									>{$allowedUserInfo[email].name ?? email}</Select.Item
								>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<fieldset class="fieldset bg-base-200 border-base-300 rounded-lg w-full border px-4 pt-0 pb-2">
					<legend class="text-sm font-semibold mb-2">分帳</legend>
					{#if $allowedUsers.length === 0}
						<p class="opacity-60 text-sm">尚未設定家庭成員</p>
					{:else}
						<div class="flex flex-col gap-2">
							{#each $allowedUsers as email (email)}
								<div class="flex items-center gap-2">
									<Label class="flex-1 truncate"
										>{$allowedUserInfo[email].name ?? email}</Label
									>
									<Input
										class="w-32 text-right"
										name={email}
										type="number"
										inputmode="decimal"
										placeholder="0"
										value={shares[email] == 0 ? '' : shares[email]}
										oninput={(e) => {
											const target = e.target as HTMLInputElement;
											shares[email] = Number(target.value);
										}}
									/>
								</div>
							{/each}
						</div>
						<div class="mt-2 text-xs text-right">
							合計：{sharesTotal} / 金額：{expenseData.amount}
							{#if expenseData.amount && !sharesValid}
								<span class="text-destructive ml-2">不相符</span>
							{/if}
						</div>
					{/if}
				</fieldset>

				<div class="flex items-center gap-2 mt-2">
					<Checkbox
						id="settled-input"
						bind:checked={expenseData.is_settled}
						disabled={expenseData?.scope !== 'household'}
					/>
					<Label for="settled-input" class="text-sm">已結清</Label>
				</div>
			</div>
		{/if}
	</fieldset>

	<div class="grid gap-2">
		<Label for="content-input">帳目內容</Label>
		<Input id="content-input" bind:value={expenseData.note} placeholder="例如：午餐便當" />
	</div>

	<Button type="submit" class="w-full" disabled={!isUpdated || $submitIsLoading || $submitIsDone}>
		{#if $submitIsLoading}
			<Icon icon="svg-spinners:90-ring-with-bg" width="20" height="20" />
		{:else if $submitIsDone}
			完成
		{:else}
			{editMode ? '更新' : '新增'}
		{/if}
	</Button>
</form>
{#if editMode}
	<Button
		variant="destructive"
		class="w-full mt-2"
		disabled={$deleteIsLoading || $deleteIsDone}
		onclick={() => {
			handleDelete(expenseId);
		}}
	>
		{#if $deleteIsLoading}
			<Icon icon="svg-spinners:90-ring-with-bg" width="20" height="20" />
		{:else if $deleteIsDone}
			完成
		{:else}
			刪除
		{/if}
	</Button>
{/if}
