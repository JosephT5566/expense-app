<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { SvelteDate, SvelteMap } from 'svelte/reactivity';

	import type { ExpenseRow } from '$lib/types/expense';

	import * as expensesStore from '$lib/stores/expenses.store';
	import * as scheduledExpensesStore from '$lib/stores/scheduled-expenses.store';
	import { categoryIconMap } from '$lib/stores/categories.store';

	import * as Dialog from '$lib/components/shadcn/dialog';
	import * as Carousel from '$lib/components/shadcn/carousel';
	import type { CarouselAPI } from '$lib/components/shadcn/carousel/context';
	import { Button } from '$lib/components/shadcn/button';
	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';

	import { getMonthlyFromCacheFirst } from '$lib/data/monthly-cache-first';
	import RetrieveExpenseButton from '$lib/components/RetrieveExpenseButton.svelte';
	import AIReceiptImportDialog from '$lib/components/AIReceiptImportDialog.svelte';
	import DailyCarouselCard from '$lib/components/DailyCarouselCard.svelte';

	import Logger from '$lib/utils/logger';
	import { user as currentUser } from '$lib/stores/session.store';

	let drawerOpen = $state(false);
	let editMode = $state(false);

	let expenseId = $state('');
	const today = new SvelteDate();
	let selectedDate = $state(toDateOnlyStr(today));
	const [selectedYear, selectedMonth] = $derived(selectedDate.split('-').map(Number));
	const monthKey = $derived(`${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);

	// 改為從 store 過濾當日資料
	const expensesItems = expensesStore.items;
	const expensesLoading = expensesStore.loading;
	const dueScheduledItems = scheduledExpensesStore.dueItems;
	const scheduledLoading = scheduledExpensesStore.loading;

	// Track completed requests, including empty months, rather than inferring them from rows.
	let monthStatus = $state<Record<string, 'loading' | 'loaded' | 'error'>>({});
	const pendingMonths = new SvelteMap<string, Promise<void>>();
	let requestGeneration = 0;

	async function ensureMonth(key: string) {
		if (!$currentUser) {
			return;
		}
		if (monthStatus[key] === 'loaded') {
			return;
		}
		if (pendingMonths.has(key)) {
			return pendingMonths.get(key);
		}
		const generation = requestGeneration;
		monthStatus[key] = 'loading';
		const request = getMonthlyFromCacheFirst(key)
			.then((rows) => {
				if (generation !== requestGeneration) {
					return;
				}
				expensesStore.setMoreItems(rows);
				monthStatus[key] = 'loaded';
			})
			.catch((error) => {
				if (generation !== requestGeneration) {
					return;
				}
				monthStatus[key] = 'error';
				Logger.error('Load carousel month failed:', key, error);
			})
			.finally(() => {
				if (generation === requestGeneration) {
					pendingMonths.delete(key);
				}
			});
		pendingMonths.set(key, request);
		return request;
	}

	$effect(() => {
		// Reset request bookkeeping when the account changes.
		const email = $currentUser?.email;
		requestGeneration += 1;
		monthStatus = {};
		pendingMonths.clear();
		if (!email) {
			return;
		}
	});

	onDestroy(() => {
		requestGeneration += 1;
	});

	$effect(() => {
		if (!$currentUser) {
			return;
		}
		const keys = new Set(dateList.map((date) => date.slice(0, 7)));
		// Date/account changes trigger loading; status writes must not retrigger this effect.
		untrack(() => {
			for (const key of keys) {
				void ensureMonth(key);
			}
		});
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

	let approvingScheduledId = $state<string | null>(null);
	let cancellingScheduledId = $state<string | null>(null);

	async function approveScheduledExpense(id: string) {
		approvingScheduledId = id;
		try {
			await scheduledExpensesStore.approve(id);
		} catch (error) {
			Logger.error('Approve scheduled expense failed:', error);
			alert('套用預定支出失敗，請稍後再試。');
		} finally {
			approvingScheduledId = null;
		}
	}

	async function cancelScheduledExpense(id: string) {
		if (!confirm('確定要取消這筆預定支出嗎？')) {
			return;
		}

		cancellingScheduledId = id;
		try {
			await scheduledExpensesStore.cancel(id);
		} catch (error) {
			Logger.error('Cancel scheduled expense failed:', error);
			alert('取消預定支出失敗，請稍後再試。');
		} finally {
			cancellingScheduledId = null;
		}
	}

	// Keep only the selected day and its neighbours mounted. At today, omit tomorrow.
	let carouselApi = $state<CarouselAPI>();
	let recentering = false;
	let carouselRevision = 0;

	function offsetDate(date: string, days: number) {
		const value = new SvelteDate(`${date}T12:00:00Z`);
		value.setUTCDate(value.getUTCDate() + days);
		return value.toISOString().slice(0, 10);
	}

	const dateList = $derived(
		[offsetDate(selectedDate, -1), selectedDate, offsetDate(selectedDate, 1)].filter(
			(date) => date <= toDateOnlyStr(today)
		)
	);

	// Group once when store rows change, rather than scanning every row in each card.
	const expensesByDate = $derived.by(() => {
		const grouped = new SvelteMap<string, ExpenseRow[]>();
		for (const row of $expensesItems) {
			const date = new Date(Date.parse(row.ts) + 8 * 60 * 60 * 1000)
				.toISOString()
				.slice(0, 10);
			const rows = grouped.get(date) ?? [];
			rows.push(row);
			grouped.set(date, rows);
		}
		return grouped;
	});

	$effect(() => {
		const api = carouselApi;
		// Subscribe to date changes so direct date jumps also recenter.
		const date = selectedDate;
		if (!api) {
			return;
		}
		const revision = ++carouselRevision;
		recentering = true;
		void tick().then(() => {
			if (revision !== carouselRevision) {
				return;
			}
			api.reInit();
			api.scrollTo(dateList.indexOf(date), true);
			recentering = false;
		});
		return () => {
			carouselRevision += 1;
		};
	});

	$effect(() => {
		const api = carouselApi;
		if (!api) {
			return;
		}
		const onSettle = () => {
			if (recentering) {
				return;
			}
			const date = dateList[api.selectedScrollSnap()];
			if (date && date !== selectedDate) {
				selectedDate = date;
			}
		};
		// Recenter only after the swipe animation finishes.
		api.on('settle', onSettle);
		return () => {
			api.off('settle', onSettle);
		};
	});
</script>

<div class="py-2">
	<div
		class="flex items-center justify-between px-4 py-3 mb-4 bg-card/50 backdrop-blur-sm rounded-2xl border border-border/50 shadow-sm"
	>
		<div class="flex items-center gap-4">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20"
			>
				<RetrieveExpenseButton {monthKey} />
			</div>
			<div class="flex flex-col">
				<span
					class="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60"
				>
					{isToday(selectedDate) ? 'Today' : 'History'}
				</span>
				<div class="relative flex items-center">
					<input
						type="date"
						aria-label="Expense date"
						value={selectedDate}
						class="bg-transparent border-none p-0 text-base font-black tracking-tight focus:ring-0 cursor-pointer appearance-none"
						max={toDateOnlyStr(today)}
						oninput={(e) => {
							const target = e.target as HTMLInputElement;
							if (!target.value) {
								selectedDate = toDateOnlyStr(today);
								return;
							}
							if (target.validity.valid) {
								selectedDate = target.value;
							}
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
					onclick={() => (selectedDate = toDateOnlyStr(today))}
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
			{#each dateList as date, index (index)}
				<Carousel.Item class="basis-[85%] pl-4">
					<DailyCarouselCard
						{date}
						{selectedDate}
						todayDate={toDateOnlyStr(today)}
						expenses={expensesByDate.get(date) ?? []}
						dueScheduledItems={$dueScheduledItems}
						expensesLoading={$expensesLoading ||
							monthStatus[date.slice(0, 7)] === 'loading'}
						loadError={monthStatus[date.slice(0, 7)] === 'error'}
						onRetry={() => ensureMonth(date.slice(0, 7))}
						scheduledLoading={$scheduledLoading}
						categoryIconMap={$categoryIconMap}
						{approvingScheduledId}
						{cancellingScheduledId}
						onCreate={() => {
							selectedDate = date;
							openCreate();
						}}
						onEdit={openEdit}
						onOpenReceiptImport={() => {
							selectedDate = date;
							aiDialogOpen = true;
						}}
						onApproveScheduled={approveScheduledExpense}
						onCancelScheduled={cancelScheduledExpense}
					/>
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
