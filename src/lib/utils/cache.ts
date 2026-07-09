export const EXPENSE_CACHE_PREFIX = 'monthly-expenses:';
export const SCHEDULED_EXPENSE_CACHE_KEY = 'scheduled-expenses:pending';

// monthKey: '2025-10'
export function getExpenseCacheKey(monthKey: string) {
	return `${EXPENSE_CACHE_PREFIX}${monthKey}`;
}
