<script lang="ts">
	import type { PreviewExpense } from '$lib/types/expense';
	import Icon from '@iconify/svelte';
	import classNames from 'classnames';
	import { allowedUserInfo, allowedUsers } from '$lib/stores/appSetting.store';
	import { expenseOptions, categoryIconMap } from '$lib/stores/categories.store';
	import Carousel from '$lib/components/ui/Carousel.svelte';
	import { derived } from 'svelte/store';
	import { toTaiwanDateString } from '$lib/utils/dates';
	import { Label } from '$lib/components/shadcn/label';
	import { Input } from '$lib/components/shadcn/input';
	import { Button } from '$lib/components/shadcn/button';
	import { Checkbox } from '$lib/components/shadcn/checkbox';
	import * as RadioGroup from '$lib/components/shadcn/radio-group';
	import * as Select from '$lib/components/shadcn/select';

	type CategoryCard = { id: string; name: string; icon: string };

	let {
		previewExpense = $bindable(),
		onClose
	}: {
		previewExpense: PreviewExpense;
		onClose?: () => void;
	} = $props();

	// 使用本地 draft 狀態，只有在按完成時才同步回 previewExpense
	let draft = $state<PreviewExpense>($state.snapshot(previewExpense));

	let selectedDate = $derived.by(() => {
		return draft.ts ? toTaiwanDateString(draft.ts) : '';
	});

	function handleDateChange(e: Event) {
		const target = e.target as HTMLInputElement;
		draft.ts = new Date(target.value).toISOString();
	}

	const today = new Date();

	// 處理範圍變動邏輯
	function handleScopeChange(newScope: string) {
		const scope = newScope as 'personal' | 'household';
		draft.scope = scope;
		
		if (scope === 'personal') {
			draft.shares_json = {};
			draft.is_settled = true;
		} else {
			// 初始化家庭成員分帳
			if ($allowedUsers.length > 0) {
				const newShares = { ...(draft.shares_json || {}) };
				for (const email of $allowedUsers) {
					if (!(email in newShares)) {
						newShares[email] = 0;
					}
				}
				draft.shares_json = newShares;
			}
			draft.is_settled = false;
		}
	}

	// shares 合計與驗證
	const sharesTotal = $derived(Object.values(draft.shares_json || {}).reduce((a, v) => a + (Number(v) || 0), 0));
	const sharesValid = $derived(Number(draft.amount || 0) === sharesTotal);

	// 轉為卡片資料並分頁
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

	function handleSubmit(e: Event) {
		e.preventDefault();
		// 將 draft 同步回綁定的 prop
		previewExpense = $state.snapshot(draft);
		onClose?.();
	}
</script>

<form class="flex flex-col gap-4" onsubmit={handleSubmit}>
	<div class="grid gap-2">
		<Label for="date-input">日期</Label>
		<Input
			id="date-input"
			type="date"
			class="w-auto"
			value={selectedDate}
			oninput={handleDateChange}
			max={toTaiwanDateString(today)}
		/>
	</div>

	<div class="grid gap-2">
		<Label for="amount-input">金額</Label>
		<div class="relative">
			<Input
				class="w-full"
				id="amount-input"
				type="number"
				inputmode="decimal"
				placeholder="輸入金額"
				value={draft.amount === 0 ? '' : draft.amount}
				oninput={(e) => {
					const target = e.target as HTMLInputElement;
					draft.amount = Number(target.value);
				}}
			/>
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
								'data-[selected=true]:text-primary data-[selected=true]:ring-2'
							)}
							data-selected={draft.category_id === cat.id}
							onclick={() => (draft.category_id = cat.id)}
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
		<RadioGroup.Root value={draft.scope} onValueChange={handleScopeChange}>
			<div class="flex gap-2">
				<Label
					for="scope-personal"
					class="flex items-center gap-2 p-2 rounded-lg border cursor-pointer flex-1 justify-center {draft.scope ===
					'personal'
						? 'bg-primary text-primary-foreground'
						: ''}"
				>
					<RadioGroup.Item value="personal" id="scope-personal" />
					個人
				</Label>
				<Label
					for="scope-household"
					class="flex items-center gap-2 p-2 rounded-lg border cursor-pointer flex-1 justify-center {draft.scope ===
					'household'
						? 'bg-primary text-primary-foreground'
						: ''}"
				>
					<RadioGroup.Item value="household" id="scope-household" />
					家庭
				</Label>
			</div>
		</RadioGroup.Root>

		{#if draft?.scope === 'household'}
			<div class="grid gap-4 mt-2">
				<div class="grid gap-2">
					<Label>付款人</Label>
					<Select.Root 
						type="single" 
						value={draft.payer_email} 
						onValueChange={(v) => draft.payer_email = v}
					>
						<Select.Trigger class="w-full">
							<Select.Value placeholder="選擇付款人" />
						</Select.Trigger>
						<Select.Content>
							{#each $allowedUsers as email (email)}
								<Select.Item value={email}
									>{$allowedUserInfo[email]?.name ?? email}</Select.Item
								>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<fieldset
					class="fieldset bg-base-200 border-base-300 rounded-lg w-full border px-4 pt-0 pb-2"
				>
					<legend class="text-sm font-semibold mb-2">分帳</legend>
					{#if $allowedUsers.length === 0}
						<p class="opacity-60 text-sm">尚未設定家庭成員</p>
					{:else}
						<div class="flex flex-col gap-2">
							{#each $allowedUsers as email (email)}
								<div class="flex items-center gap-2">
									<Label class="flex-1 truncate"
										>{$allowedUserInfo[email]?.name ?? email}</Label
									>
									<Input
										class="w-32 text-right"
										name={email}
										type="number"
										inputmode="decimal"
										placeholder="0"
										value={draft.shares_json?.[email] == 0 ? '' : draft.shares_json?.[email]}
										oninput={(e) => {
											const target = e.target as HTMLInputElement;
											if (draft.shares_json) {
												draft.shares_json[email] = Number(target.value);
											}
										}}
									/>
								</div>
							{/each}
						</div>
						<div class="mt-2 text-xs text-right">
							合計：{sharesTotal} / 金額：{draft.amount}
							{#if draft.amount && !sharesValid}
								<span class="text-destructive ml-2">不相符</span>
							{/if}
						</div>
					{/if}
				</fieldset>

				<div class="flex items-center gap-2 mt-2">
					<Checkbox
						id="settled-input"
						bind:checked={draft.is_settled}
						disabled={draft?.scope !== 'household'}
					/>
					<Label for="settled-input" class="text-sm">已結清</Label>
				</div>
			</div>
		{/if}
	</fieldset>

	<div class="grid gap-2">
		<Label for="content-input">帳目內容</Label>
		<Input id="content-input" bind:value={draft.note} placeholder="例如：午餐便當" />
	</div>

	<Button type="submit" class="w-full">完成</Button>
</form>
