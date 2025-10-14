export const EXPENSE_CACHE_PREFIX =  'monthly-expenses:';

// monthKey: '2025-10'
export function getExpenseCacheKey(monthKey: string) {
	return `${EXPENSE_CACHE_PREFIX}${monthKey}`;
}
