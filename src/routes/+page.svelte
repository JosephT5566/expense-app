<script lang="ts">
	import _isEmpty from 'lodash/isEmpty';

	import type { ExpenseRow } from '$lib/types/expense';

	import * as expensesStore from '$lib/stores/expenses.store';
	import { categoryIconMap } from '$lib/stores/categories.store';

	import * as Dialog from '$lib/components/shadcn/dialog';
	import * as Carousel from '$lib/components/shadcn/carousel';
	import type { CarouselAPI } from '$lib/components/shadcn/carousel/context';
	import { Button } from '$lib/components/shadcn/button';
	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';

	import { taiwanDayBoundsISO } from '$lib/utils/dates';
	import { getMonthlyFromCacheFirst } from '$lib/data/monthly-cache-first';
	import RetrieveExpenseButton from '$lib/components/RetrieveExpenseButton.svelte';
	import AIReceiptImportDialog from '$lib/components/AIReceiptImportDialog.svelte';

	import Logger from '$lib/utils/logger';
	import { Sparkles, TreePalm } from 'lucide-svelte';

	let drawerOpen = $state(false);
	let editMode = $state(false);

	let expenseId = $state('');
	const today = new Date();
	let selectedDate = $state(toDateOnlyStr(today));
	const [selectedYear, selectedMonth] = $derived(selectedDate.split('-').map(Number));
	const monthKey = $derived(`${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);

	// 改為從 store 過濾當日資料
	const expensesItems = expensesStore.items;
	const expensesLoading = expensesStore.loading;

	// 依選擇日期，若該月份資料未在 store 中，則載入該月份
	$effect(() => {
		if (selectedDate === toDateOnlyStr(today)) {
			return;
		}

		// when state selectedDate changes
		// check if we have any item in this month in the expenses store
		if (!expensesStore.hasMonthExpenses(selectedYear, selectedMonth)) {
			getMonthlyFromCacheFirst(monthKey).then((newMonthExpense) => {
				if (_isEmpty(newMonthExpense)) {
					return;
				}
				expensesStore.setMoreItems(newMonthExpense);
			});
		}
	});

	function toDateOnlyStr(d: Date) {
		const y = d.getFullYear(),
			m = String(d.getMonth() + 1).padStart(2, '0'),
			da = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${da}`;
	}
	function isToday(dateStr: string) {
		return dateStr === toDateOnlyStr(today);
	}

	function openCreate() {
		editMode = false;
		drawerOpen = true;
	}

	function openEdit(e: ExpenseRow) {
		editMode = true;
		expenseId = e.id;
		drawerOpen = true;
	}

	let aiDialogOpen = $state(false);

	function handleImport(expenses: ExpenseRow[]) {
		Logger.log('Importing expenses:', expenses);
		expensesStore.setMoreItems(expenses);
	}

	// Carousel sync logic
	let carouselApi = $state<CarouselAPI>();
	let initialized = $state(false);

	const dateList = $derived.by(() => {
		const list = [];
		const start = new Date(today);
		start.setDate(start.getDate() - 60);
		for (let i = 0; i <= 60; i++) {
			const d = new Date(start);
			d.setDate(d.getDate() + i);
			list.push(toDateOnlyStr(d));
		}
		return list;
	});

	$effect(() => {
		if (carouselApi && selectedDate) {
			const index = dateList.indexOf(selectedDate);
			if (index !== -1 && index !== carouselApi.selectedScrollSnap()) {
				carouselApi.scrollTo(index, !initialized);
				initialized = true;
			}
		}
	});

	$effect(() => {
		if (carouselApi) {
			const onSelect = () => {
				const index = carouselApi!.selectedScrollSnap();
				const newDate = dateList[index];
				if (newDate && newDate !== selectedDate) {
					selectedDate = newDate;
				}
			};
			carouselApi.on('select', onSelect);
			return () => carouselApi!.off('select', onSelect);
		}
	});
</script>

<div class="py-2">
	<div class="flex items-center justify-between px-4 py-3 mb-4 bg-card/50 backdrop-blur-sm rounded-2xl border border-border/50 shadow-sm">
		<div class="flex items-center gap-4">
			<div class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20">
				<RetrieveExpenseButton {monthKey} />
			</div>
			<div class="flex flex-col">
				<span class="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60">
					{isToday(selectedDate) ? 'Today' : 'History'}
				</span>
				<div class="relative flex items-center">
					<input
						type="date"
						value={selectedDate}
						class="bg-transparent border-none p-0 text-base font-black tracking-tight focus:ring-0 cursor-pointer appearance-none"
						max={toDateOnlyStr(today)}
						oninput={(e) => {
							const target = e.target as HTMLInputElement;
							if (!target.value) {
								selectedDate = toDateOnlyStr(today);
								return;
							}
							selectedDate = target.value;
						}}
					/>
				</div>
			</div>
		</div>

		<div class="flex items-center gap-2">
			{#if !isToday(selectedDate)}
				<Button 
					variant="secondary" 
					size="sm" 
					class="h-8 rounded-full px-4 text-[10px] font-black uppercase tracking-widest shadow-sm transition-all hover:scale-105 active:scale-95"
					onclick={() => selectedDate = toDateOnlyStr(today)}
				>
					Today
				</Button>
			{/if}
		</div>
	</div>

	<Carousel.Root
		setApi={(api) => (carouselApi = api)}
		opts={{ align: 'center', containScroll: false }}
		class="w-full"
	>
		<Carousel.Content class="items-start">
			{#each dateList as date (date)}
				{@const { from, to } = taiwanDayBoundsISO(date)}
				{@const items = ($expensesItems ?? []).filter((e) => e.ts >= from && e.ts <= to)}
				<Carousel.Item class="basis-[85%] pl-4">
					<section class="card p-4">
						{#if $expensesLoading && items.length === 0 && selectedDate === date}
							<p class="mt-3 opacity-70 text-sm font-medium">載入中…</p>
						{:else}
							{#if items.length !== 0}
								<ExpenseListSection
									{items}
									categoryIconMap={$categoryIconMap}
									onEdit={openEdit}
									showSum={true}
								/>
							{:else}
								<div class="py-12 flex flex-col items-center justify-center opacity-30">
									<TreePalm class="w-8 h-8 mb-2" />
									<p class="text-xs font-bold uppercase tracking-widest">No Records</p>
								</div>
							{/if}
							<div class="mt-4 flex gap-2">
								<Button class="grow font-bold shadow-sm" onclick={openCreate}
									>{items.length === 0 ? '今日第一筆記帳' : '新增項目'}</Button
								>
								<Button
									class="text-primary hover:bg-primary/5 border-primary/20"
									variant="outline"
									onclick={() => (aiDialogOpen = true)}
								>
									<Sparkles class="w-5 h-5" />
								</Button>
							</div>
						{/if}
					</section>
				</Carousel.Item>
			{/each}
		</Carousel.Content>
	</Carousel.Root>
</div>

<Dialog.Root bind:open={drawerOpen}>
	<Dialog.Content class="max-h-[75vh] overflow-y-auto sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>{editMode ? '編輯項目' : '新增項目'}</Dialog.Title>
		</Dialog.Header>
		<ExpenseDrawerContent
			expenseId={editMode ? expenseId : undefined}
			{selectedDate}
			{editMode}
			onSubmitFinish={() => {
				drawerOpen = false;
			}}
		/>
	</Dialog.Content>
</Dialog.Root>

<AIReceiptImportDialog bind:open={aiDialogOpen} onImport={handleImport} />
