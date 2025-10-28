<script lang="ts">
	import { Dialog } from 'bits-ui';

	import type { ExpenseRow } from '$lib/types/expense';

	import * as expensesStore from '$lib/stores/expenses.store';
	import { categoryIconMap } from '$lib/stores/categories.store';

	import SwipeDrawer from '$lib/components/ui/SwipeDrawer.svelte';
	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';

	import { taiwanDayBoundsISO, taiwanMonthBoundsISO } from '$lib/utils/dates';
	import { getMonthlyFromCacheFirst } from '$lib/data/monthly-cache-first';

	let drawerOpen = $state(false);
	let editMode = $state(false);

	$effect(() => {
		console.log('drawerOpen', drawerOpen);
	});

	let expenseId = $state('');
	const today = new Date();
	let selectedDate = $state(toDateOnlyStr(today));
	let showDatePicker = $state(false);
	// 改為從 store 過濾當日資料
	const expensesItems = expensesStore.items;
	const expensesLoading = expensesStore.loading;
	const dayItems = $derived(() => {
		const { from, to } = taiwanDayBoundsISO(selectedDate);
		return ($expensesItems ?? []).filter((e) => e.ts >= from && e.ts <= to);
	});

	// 依選擇日期，若該月份資料未在 store 中，則載入該月份
	const inflightMonths: Record<string, boolean> = $state({});
	$effect(() => {
		// when state selectedDate changes
		if ($expensesItems.length === 0) {
			return;
		}

		const d = new Date(selectedDate);
		const y = d.getFullYear();
		const m = d.getMonth() + 1;
		const key = `${y}-${String(m).padStart(2, '0')}`;
		const { from, to } = taiwanMonthBoundsISO(y, m);

		// check if we have any item in this month in the expenses store
		const hasMonth = $expensesItems.some((e) => e.ts >= from && e.ts <= to);

		if (!hasMonth && !inflightMonths[key]) {
			inflightMonths[key] = true;
			getMonthlyFromCacheFirst(`${y}-${String(m).padStart(2, '0')}`)
				.then((newMonthExpense) => {
					expensesStore.setMoreItems(newMonthExpense);
				})
				.finally(() => {
					inflightMonths[key] = false;
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
		drawerOpen = true;
	}

	function openEdit(e: ExpenseRow) {
		editMode = true;
		expenseId = e.id;
		// 初始化分帳
		drawerOpen = true;
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
	{#if $expensesLoading && dayItems().length === 0}
		<p class="mt-3 opacity-70">載入中…</p>
	{:else if dayItems().length === 0}
		<div class="mt-3">
			<button class="btn btn-primary w-full" onclick={openCreate}>輸入今日第一筆記帳</button>
		</div>
	{:else}
		<ExpenseListSection
			items={dayItems()}
			categoryIconMap={$categoryIconMap}
			onEdit={openEdit}
		/>
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
	<ExpenseDrawerContent
		expenseId={editMode ? expenseId : undefined}
		{editMode}
		onSubmitFinish={() => {
			drawerOpen = false;
		}}
	/>
</SwipeDrawer>

<style>
</style>
