import { writable, derived } from 'svelte/store';
import type { ExpenseQuery } from '$lib/types/expense';

export const scopeFilter = writable<ExpenseQuery['scope']>('all');
export const settledFilter = writable<ExpenseQuery['settled']>('all');
export const searchFilter = writable<string>('');
export const dateRange = writable<{ from?: string; to?: string }>({});

export const effectiveQuery = derived(
	[scopeFilter, settledFilter, searchFilter, dateRange],
	([$scope, $settled, $search, $range]) => {
		const q: ExpenseQuery = {
			scope: $scope,
			settled: $settled,
			search: $search || undefined,
			from: $range.from,
			to: $range.to,
			limit: 50,
		};
		return q;
	}
);
