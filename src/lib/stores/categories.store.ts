import { writable, derived } from 'svelte/store';
import type { CategoryRow, CategoryKind } from '$lib/types/category';
import { listCategories } from '$lib/data/categories.fetcher';

function createCategoriesStore() {
	const items = writable<CategoryRow[]>([]);
	const loading = writable(false);
	const error = writable<unknown>(null);

	async function load(kind?: CategoryKind) {
		loading.set(true);
		error.set(null);
		try {
			const res = await listCategories(kind ? { kind } : {});
			items.set(res);
		} catch (e) {
			error.set(e);
		} finally {
			loading.set(false);
		}
	}

	// options for selects, keyed by kind
	const expenseOptions = derived(items, ($items) =>
		$items
			.filter((c) => c.kind === 'expense')
			.map((c) => ({ value: c.id, label: c.name }))
	);
	const incomeOptions = derived(items, ($items) =>
		$items
			.filter((c) => c.kind === 'income')
			.map((c) => ({ value: c.id, label: c.name }))
	);

	return { items, loading, error, load, expenseOptions, incomeOptions };
}

export const categoriesStore = createCategoriesStore();
