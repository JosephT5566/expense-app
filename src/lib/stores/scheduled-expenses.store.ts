import { derived, get, readable, writable } from 'svelte/store';
import {
	cancelScheduledExpense,
	confirmScheduledExpense,
	deleteScheduledExpense,
	type UpsertScheduledExpenseInput,
	upsertScheduledExpense
} from '$lib/data/scheduled-expenses.fetcher';
import {
	getPendingScheduledFromCacheFirst,
	revalidatePendingScheduledInBackground
} from '$lib/data/scheduled-cache-first';
import {
	persistScheduledExpenseDelete,
	persistScheduledExpensePatch
} from '$lib/cache/scheduledExpenses';
import type { ScheduledExpenseRow } from '$lib/types/expense';
import * as expensesStore from '$lib/stores/expenses.store';
import Logger from '$lib/utils/logger';

export const items = writable<ScheduledExpenseRow[]>([]);
export const loading = writable(false);
export const error = writable<unknown>(null);
export const loaded = writable(false);
const nowISO = readable(new Date().toISOString(), (set) => {
	const timer = setInterval(() => set(new Date().toISOString()), 60 * 1000);
	return () => clearInterval(timer);
});

export const dueItems = derived([items, nowISO], ([$items, $nowISO]) => {
	return $items
		.filter((row) => row.status === 'pending' && row.scheduled_for <= $nowISO)
		.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
});

export function setPendingItems(rows: ScheduledExpenseRow[]) {
	items.set(sortPending(rows));
	loaded.set(true);
}

export async function loadPending(params: { force?: boolean } = {}) {
	if (!params.force && get(loaded)) {
		return;
	}

	loading.set(true);
	error.set(null);

	try {
		const rows = params.force
			? await revalidatePendingScheduledInBackground()
			: await getPendingScheduledFromCacheFirst();
		setPendingItems(rows);
	} catch (e) {
		error.set(e);
		Logger.error('Load scheduled expenses failed:', e);
	} finally {
		loading.set(false);
	}
}

export async function save(input: UpsertScheduledExpenseInput) {
	const row = await upsertScheduledExpense(input);
	upsertLocal(row);
	await persistScheduledExpensePatch(row);
	return row;
}

export async function remove(id: string) {
	const { status } = await deleteScheduledExpense(id);
	if (status !== 204) {
		throw new Error(`Failed to delete scheduled expense, status code: ${status}`);
	}

	removeLocal(id);
	await persistScheduledExpenseDelete(id);
}

export async function cancel(id: string) {
	const row = await cancelScheduledExpense(id);
	removeLocal(id);
	await persistScheduledExpensePatch(row);
	return row;
}

export async function approve(id: string) {
	const result = await confirmScheduledExpense(id);
	expensesStore.upsertOne(result.expense);

	if (result.scheduledExpense.status === 'pending') {
		upsertLocal(result.scheduledExpense);
		await persistScheduledExpensePatch(result.scheduledExpense);
	} else {
		removeLocal(id);
		await persistScheduledExpenseDelete(id);
	}

	return result;
}

export function clearAll() {
	items.set([]);
	error.set(null);
	loaded.set(false);
}

function upsertLocal(row: ScheduledExpenseRow) {
	items.update((prev) => sortPending([row, ...prev.filter((item) => item.id !== row.id)]));
}

function removeLocal(id: string) {
	items.update((prev) => prev.filter((row) => row.id !== id));
}

function sortPending(rows: ScheduledExpenseRow[]) {
	return rows
		.filter((row) => row.status === 'pending')
		.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
}
