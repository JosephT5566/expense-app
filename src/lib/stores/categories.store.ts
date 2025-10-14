import { writable, derived } from 'svelte/store';
import type { CategoryRow } from '$lib/types/category';

export const items = writable<CategoryRow[]>([]);
export const loading = writable(false);
export const error = writable<unknown>(null);
export function setFromLoad(list: CategoryRow[]) {
	items.set(list);
	loading.set(false);
}

export const expenseOptions = derived(items, ($items) =>
	$items.filter((c) => c.kind === 'expense').map((c) => ({ value: c.id, label: c.name }))
);
export const incomeOptions = derived(items, ($items) =>
	$items.filter((c) => c.kind === 'income').map((c) => ({ value: c.id, label: c.name }))
);
