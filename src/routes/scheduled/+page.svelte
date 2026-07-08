<script lang="ts">
	import Icon from '@iconify/svelte';
	import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-svelte';
	import { SvelteDate } from 'svelte/reactivity';

	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';
	import * as Tabs from '$lib/components/shadcn/tabs';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import * as Select from '$lib/components/shadcn/select';
	import { Button } from '$lib/components/shadcn/button';
	import { Input } from '$lib/components/shadcn/input';
	import { Label } from '$lib/components/shadcn/label';
	import { categoryIconMap, expenseOptions } from '$lib/stores/categories.store';
	import { user as currentUser } from '$lib/stores/session.store';
	import type { UpsertExpenseInput } from '$lib/data/expenses.fetcher';
	import * as scheduledExpensesStore from '$lib/stores/scheduled-expenses.store';
	import type {
		Currency,
		ExpenseRow,
		ScheduledExpenseKind,
		ScheduledExpenseRecurrence,
		ScheduledExpenseRow
	} from '$lib/types/expense';

	type TabValue = ScheduledExpenseKind;

	const weekdays = [
		{ value: '0', label: '週日' },
		{ value: '1', label: '週一' },
		{ value: '2', label: '週二' },
		{ value: '3', label: '週三' },
		{ value: '4', label: '週四' },
		{ value: '5', label: '週五' },
		{ value: '6', label: '週六' }
	];

	const recurrenceOptions: { value: ScheduledExpenseRecurrence; label: string }[] = [
		{ value: 'daily', label: '每天' },
		{ value: 'weekly', label: '每週' },
		{ value: 'monthly', label: '每月' }
	];

	let activeTab = $state<TabValue>('one_time');
	let dialogOpen = $state(false);
	let editingId = $state<string | null>(null);
	let drawerKey = $state(0);
	let scheduledDate = $state(toDateInputValue(new SvelteDate()));
	let recurrenceRule = $state<ScheduledExpenseRecurrence>('monthly');
	let recurrenceWeekday = $state(String(new SvelteDate().getDay()));
	let recurrenceMonthDay = $state(String(new SvelteDate().getDate()));
	let errorMessage = $state('');
	let initialExpense = $state<Partial<ExpenseRow>>({});
	let deletingId = $state<string | null>(null);
	let loadedForEmail = $state<string | null>(null);
	const rows = scheduledExpensesStore.items;
	const loading = scheduledExpensesStore.loading;

	const oneTimeRows = $derived(
		$rows
			.filter((row) => row.kind === 'one_time' && row.status === 'pending')
			.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for))
	);
	const recurringRows = $derived(
		$rows
			.filter((row) => row.kind === 'recurring' && row.status === 'pending')
			.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for))
	);

	const dialogTitle = $derived(
		editingId ? '編輯預定支出' : activeTab === 'one_time' ? '新增單次預定支出' : '新增定期支出'
	);

	$effect(() => {
		const userEmail = $currentUser?.email ?? '';

		if (!userEmail) {
			scheduledExpensesStore.clearAll();
			loadedForEmail = null;
			return;
		}

		if (loadedForEmail === userEmail) {
			return;
		}

		loadedForEmail = userEmail;
		void scheduledExpensesStore.loadPending();
	});

	function openCreate() {
		resetForm(activeTab);
		drawerKey += 1;
		dialogOpen = true;
	}

	function openEdit(row: ScheduledExpenseRow) {
		activeTab = row.kind;
		editingId = row.id;
		scheduledDate = toDateInputValue(new SvelteDate(row.scheduled_for));
		recurrenceRule = row.recurrence_rule ?? 'monthly';
		recurrenceWeekday = String(
			row.recurrence_weekday ?? new SvelteDate(row.scheduled_for).getDay()
		);
		recurrenceMonthDay = String(
			row.recurrence_month_day ?? new SvelteDate(row.scheduled_for).getDate()
		);
		initialExpense = {
			note: row.note,
			amount: row.amount,
			currency: row.currency,
			ts: row.scheduled_for,
			scope: row.scope,
			payer_email: row.payer_email,
			shares_json: { ...row.shares_json },
			category_id: row.category_id ?? '',
			is_settled: row.scope === 'personal'
		};
		errorMessage = '';
		drawerKey += 1;
		dialogOpen = true;
	}

	function resetForm(kind: ScheduledExpenseKind) {
		const userEmail = $currentUser?.email ?? '';
		const today = new SvelteDate();
		editingId = null;
		scheduledDate = toDateInputValue(today);
		recurrenceRule = kind === 'recurring' ? 'monthly' : 'daily';
		recurrenceWeekday = String(today.getDay());
		recurrenceMonthDay = String(today.getDate());
		initialExpense = {
			note: '',
			amount: 0,
			currency: 'TWD',
			ts: today.toISOString(),
			scope: 'personal',
			payer_email: userEmail,
			shares_json: userEmail ? { [userEmail]: 0 } : {},
			category_id: $expenseOptions[0]?.value ?? '',
			is_settled: true
		};
		errorMessage = '';
	}

	async function handleDelete(id: string) {
		if (!confirm('確定要刪除這筆預定支出嗎？')) {
			return;
		}

		deletingId = id;
		errorMessage = '';

		try {
			await scheduledExpensesStore.remove(id);
		} catch (error) {
			console.error('Delete scheduled expense error:', error);
			errorMessage = '刪除預定支出失敗，請稍後再試。';
		} finally {
			deletingId = null;
		}
	}

	async function handleScheduledSubmit(payload: UpsertExpenseInput) {
		const error = validateForm();
		if (error) {
			errorMessage = error;
			throw new Error(error);
		}

		const userEmail = $currentUser?.email ?? payload.payer_email;
		const kind = activeTab;
		const baseDate = scheduledDate;
		errorMessage = '';

		try {
			await scheduledExpensesStore.save({
				id: editingId ?? undefined,
				owner_email: userEmail,
				payer_email: payload.payer_email || userEmail,
				note: payload.note.trim(),
				amount: Number(payload.amount),
				currency: payload.currency as Currency,
				scheduled_for: getScheduledISO(kind, baseDate),
				scope: payload.scope,
				shares_json: payload.shares_json,
				category_id: payload.category_id,
				kind,
				recurrence_rule: kind === 'recurring' ? recurrenceRule : null,
				recurrence_weekday:
					kind === 'recurring' && recurrenceRule === 'weekly'
						? Number(recurrenceWeekday)
						: null,
				recurrence_month_day:
					kind === 'recurring' && recurrenceRule === 'monthly'
						? Number(recurrenceMonthDay)
						: null
			});
		} catch (error) {
			console.error('Upsert scheduled expense error:', error);
			errorMessage = '儲存預定支出失敗，請稍後再試。';
			throw error;
		}

		dialogOpen = false;
	}

	function validateForm() {
		if (!scheduledDate) {
			return '請選擇日期';
		}
		if (activeTab === 'recurring' && recurrenceRule === 'weekly' && recurrenceWeekday === '') {
			return '請選擇星期';
		}
		if (activeTab === 'recurring' && recurrenceRule === 'monthly') {
			const day = Number(recurrenceMonthDay);
			if (!Number.isInteger(day) || day < 1 || day > 31) {
				return '請選擇 1 到 31 之間的日期';
			}
		}
		return '';
	}

	function handleScheduleDateInput(event: Event) {
		const target = event.target as HTMLInputElement;
		scheduledDate = target.value;
		initialExpense = {
			...initialExpense,
			ts: dateInputToISO(scheduledDate)
		};
	}

	function getScheduledISO(kind: ScheduledExpenseKind, fromDate: string) {
		if (kind === 'one_time' || recurrenceRule === 'daily') {
			return dateInputToISO(fromDate);
		}

		if (recurrenceRule === 'weekly') {
			return getNextWeekdayISO(fromDate, Number(recurrenceWeekday));
		}

		return getNextMonthDayISO(fromDate, Number(recurrenceMonthDay));
	}

	function getRecurrenceText(row: ScheduledExpenseRow) {
		if (row.kind === 'one_time') {
			return '單次';
		}
		if (row.recurrence_rule === 'daily') {
			return '每天';
		}
		if (row.recurrence_rule === 'weekly') {
			return `每週${weekdays.find((day) => day.value === String(row.recurrence_weekday))?.label.replace('週', '') ?? ''}`;
		}
		return `每月 ${row.recurrence_month_day} 日`;
	}

	function getCategoryLabel(categoryId?: string | null) {
		return $expenseOptions.find((option) => option.value === categoryId)?.label ?? '未分類';
	}

	function toDateInputValue(date: Date) {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function dateInputToISO(value: string) {
		return new SvelteDate(`${value}T00:00:00+08:00`).toISOString();
	}

	function getNextWeekdayISO(fromDate: string, weekday: number) {
		const date = new SvelteDate(`${fromDate}T00:00:00+08:00`);
		const diff = (weekday - date.getDay() + 7) % 7 || 7;
		date.setDate(date.getDate() + diff);
		return date.toISOString();
	}

	function getNextMonthDayISO(fromDate: string, monthDay: number) {
		const date = new SvelteDate(`${fromDate}T00:00:00+08:00`);
		const target = new SvelteDate(date);
		const lastDay = new SvelteDate(target.getFullYear(), target.getMonth() + 1, 0).getDate();
		target.setDate(Math.min(monthDay, lastDay));
		if (target <= date) {
			target.setMonth(target.getMonth() + 1, 1);
			const nextLastDay = new SvelteDate(
				target.getFullYear(),
				target.getMonth() + 1,
				0
			).getDate();
			target.setDate(Math.min(monthDay, nextLastDay));
		}
		return target.toISOString();
	}

	function formatDate(iso: string) {
		return new Intl.DateTimeFormat('zh-TW', {
			month: 'short',
			day: 'numeric',
			weekday: 'short'
		}).format(new SvelteDate(iso));
	}

	function formatAmount(value: number) {
		return new Intl.NumberFormat('zh-TW', {
			style: 'currency',
			currency: 'TWD',
			maximumFractionDigits: 0
		}).format(value);
	}
</script>

<section>
	<div class="mb-4 flex items-center justify-between gap-3">
		<div>
			<p class="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
				Scheduled
			</p>
			<h1 class="text-2xl font-black tracking-tight">預定支出</h1>
		</div>
		<Button onclick={openCreate} class="gap-2">
			<Plus class="h-4 w-4" />
			新增
		</Button>
	</div>

	<div class="card p-4 space-y-4">
		{#if errorMessage && !dialogOpen}
			<p class="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{errorMessage}
			</p>
		{/if}

		<Tabs.Root bind:value={activeTab} class="w-full">
			<Tabs.List class="grid w-full grid-cols-2">
				<Tabs.Trigger value="one_time">單次</Tabs.Trigger>
				<Tabs.Trigger value="recurring">定期</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="one_time">
				{@render ScheduleList({
					rows: oneTimeRows,
					onEdit: openEdit,
					onDelete: handleDelete,
					deletingId,
					getCategoryLabel,
					getRecurrenceText,
					formatDate,
					formatAmount,
					categoryIconMap: $categoryIconMap
				})}
			</Tabs.Content>

			<Tabs.Content value="recurring">
				{@render ScheduleList({
					rows: recurringRows,
					onEdit: openEdit,
					onDelete: handleDelete,
					deletingId,
					getCategoryLabel,
					getRecurrenceText,
					formatDate,
					formatAmount,
					categoryIconMap: $categoryIconMap
				})}
			</Tabs.Content>
		</Tabs.Root>

		{#if $loading}
			<p class="text-sm text-muted-foreground">讀取中...</p>
		{/if}
	</div>
</section>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="max-h-[82vh] overflow-y-auto sm:max-w-[500px]">
		<Dialog.Header>
			<Dialog.Title>{dialogTitle}</Dialog.Title>
			<Dialog.Description>還沒套用到帳本的支出會先留在這裡。</Dialog.Description>
		</Dialog.Header>

		<div class="mt-2 space-y-4">
			<div class="grid gap-2">
				<Label for="scheduled-date">日期</Label>
				<Input
					id="scheduled-date"
					type="date"
					value={scheduledDate}
					oninput={handleScheduleDateInput}
				/>
			</div>

			{#if activeTab === 'recurring'}
				<div class="grid gap-2">
					<Label>頻率</Label>
					<Select.Root type="single" bind:value={recurrenceRule}>
						<Select.Trigger class="w-full">
							<Select.Value placeholder="選擇頻率" />
						</Select.Trigger>
						<Select.Content>
							{#each recurrenceOptions as option (option.value)}
								<Select.Item value={option.value} label={option.label} />
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				{#if recurrenceRule === 'weekly'}
					<div class="grid gap-2">
						<Label>星期</Label>
						<Select.Root type="single" bind:value={recurrenceWeekday}>
							<Select.Trigger class="w-full">
								<Select.Value placeholder="選擇星期" />
							</Select.Trigger>
							<Select.Content>
								{#each weekdays as weekday (weekday.value)}
									<Select.Item value={weekday.value} label={weekday.label} />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				{/if}

				{#if recurrenceRule === 'monthly'}
					<div class="grid gap-2">
						<Label for="month-day">每月日期</Label>
						<Input
							id="month-day"
							type="number"
							min="1"
							max="31"
							bind:value={recurrenceMonthDay}
						/>
					</div>
				{/if}
			{/if}

			{#if errorMessage}
				<p class="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{errorMessage}
				</p>
			{/if}

			{#key drawerKey}
				<ExpenseDrawerContent
					{initialExpense}
					selectedDate={scheduledDate}
					showDate={false}
					dateDisabled={false}
					dateMax={undefined}
					submitLabel="儲存"
					disableSubmitUntilChanged={false}
					showDelete={false}
					onSubmitExpense={handleScheduledSubmit}
					onSubmitFinish={() => {
						if (!errorMessage) {
							dialogOpen = false;
						}
					}}
				/>
			{/key}
		</div>
	</Dialog.Content>
</Dialog.Root>

{#snippet ScheduleList({
	rows,
	onEdit,
	onDelete,
	deletingId,
	getCategoryLabel,
	getRecurrenceText,
	formatDate,
	formatAmount,
	categoryIconMap
}: {
	rows: ScheduledExpenseRow[];
	onEdit: (row: ScheduledExpenseRow) => void;
	onDelete: (id: string) => void | Promise<void>;
	deletingId: string | null;
	getCategoryLabel: (id?: string | null) => string;
	getRecurrenceText: (row: ScheduledExpenseRow) => string;
	formatDate: (iso: string) => string;
	formatAmount: (value: number) => string;
	categoryIconMap: Record<string, string>;
})}
	{#if rows.length === 0}
		<div class="mt-4 rounded-lg border border-dashed p-8 text-center">
			<CalendarClock class="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
			<p class="font-semibold">沒有尚未套用的預定支出</p>
			<p class="mt-1 text-sm text-muted-foreground">
				新增後會先出現在這裡，等之後再套用到帳本。
			</p>
		</div>
	{:else}
		<div class="mt-4 space-y-3">
			{#each rows as row (row.id)}
				<article class="rounded-lg border bg-card p-3 shadow-sm">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span
									class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
								>
									{#if categoryIconMap[row.category_id ?? '']}
										<Icon
											icon={categoryIconMap[row.category_id ?? '']}
											width="18"
											height="18"
										/>
									{:else}
										<CalendarClock class="h-4 w-4" />
									{/if}
								</span>
								<div class="min-w-0">
									<h2 class="truncate font-bold">{row.note}</h2>
									<p class="text-xs text-muted-foreground">
										{getCategoryLabel(row.category_id)} · {getRecurrenceText(
											row
										)}
									</p>
								</div>
							</div>
							<div class="mt-3 flex flex-wrap gap-2 text-xs">
								<span class="rounded-md bg-muted px-2 py-1"
									>{formatDate(row.scheduled_for)}</span
								>
								<span class="rounded-md bg-muted px-2 py-1"
									>{row.scope === 'household' ? '家庭' : '個人'}</span
								>
							</div>
						</div>
						<div class="shrink-0 text-right">
							<p class="font-black">{formatAmount(row.amount)}</p>
							<div class="mt-3 flex justify-end gap-1">
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="編輯"
									onclick={() => onEdit(row)}
								>
									<Pencil class="h-4 w-4" />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="刪除"
									class="text-destructive hover:bg-destructive/10"
									disabled={deletingId === row.id}
									onclick={() => onDelete(row.id)}
								>
									<Trash2 class="h-4 w-4" />
								</Button>
							</div>
						</div>
					</div>
				</article>
			{/each}
		</div>
	{/if}
{/snippet}
