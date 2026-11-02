import type { ExpenseRow, ExpenseScope } from '$lib/types/expense';
import { isWithinRange, taiwanMonthBoundsISO } from '$lib/utils/dates';

export type CategoryGroup = { id: string; amount: number; items: ExpenseRow[] };

/**
 * Group one Taiwan month's expenses by category for the summary page, largest amount first.
 * `monthKey` is 'YYYY-MM'. The personal tab lists every row of the month (personal rows count
 * their amount, household rows the user's share); the household tab lists household rows only.
 */
export function groupMonthExpensesByCategory(
	rows: ExpenseRow[],
	monthKey: string,
	scope: ExpenseScope,
	userEmail: string
): CategoryGroup[] {
	const [year, month] = monthKey.split('-').map(Number);
	const { from, to } = taiwanMonthBoundsISO(year, month);
	const monthRows = rows.filter((e) => isWithinRange(e.ts, from, to));
	const list = scope === 'personal' ? monthRows : monthRows.filter((e) => e.scope === scope);

	const groups = new Map<string, CategoryGroup>();
	for (const exp of list) {
		const id = exp.category_id ?? 'uncategorized';
		let group = groups.get(id);
		if (!group) {
			group = { id, amount: 0, items: [] };
			groups.set(id, group);
		}
		if (exp.scope === 'personal') {
			group.amount += exp.amount;
		} else if (exp.scope === 'household') {
			group.amount += exp.shares_json?.[userEmail] ?? 0;
		}
		group.items.push(exp);
	}

	return [...groups.values()].sort((a, b) => b.amount - a.amount);
}
