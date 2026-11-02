import { describe, expect, it } from 'vitest';
import type { ExpenseRow } from '$lib/types/expense';
import { groupMonthExpensesByCategory } from '$lib/utils/summary';

function row(id: string, ts: string, amount: number, extra: Partial<ExpenseRow> = {}): ExpenseRow {
	return {
		id,
		payer_email: 'me@example.com',
		note: id,
		amount,
		currency: 'TWD',
		ts,
		scope: 'personal',
		shares_json: {},
		category_id: 'food',
		meta: '',
		created_at: ts,
		updated_at: ts,
		is_settled: false,
		...extra
	};
}

function total(groups: ReturnType<typeof groupMonthExpensesByCategory>) {
	return groups.reduce((sum, g) => sum + g.amount, 0);
}

describe('groupMonthExpensesByCategory', () => {
	it('follows the selected month: October (empty) -> November (999) -> October shows nothing', () => {
		// Codex repro for finding 6: the rows do not change between switches.
		const rows = [row('nov-1', '2026-11-03T02:00:00.000Z', 999)];

		expect(groupMonthExpensesByCategory(rows, '2026-10', 'personal', 'me@example.com')).toEqual(
			[]
		);
		expect(
			total(groupMonthExpensesByCategory(rows, '2026-11', 'personal', 'me@example.com'))
		).toBe(999);
		expect(groupMonthExpensesByCategory(rows, '2026-10', 'personal', 'me@example.com')).toEqual(
			[]
		);
	});

	it('uses Taiwan month boundaries', () => {
		const rows = [
			// 2026-10-31 23:30 in Taiwan.
			row('oct-last', '2026-10-31T15:30:00.000Z', 10),
			// 2026-11-01 00:30 in Taiwan.
			row('nov-first', '2026-10-31T16:30:00.000Z', 20)
		];

		expect(
			total(groupMonthExpensesByCategory(rows, '2026-10', 'personal', 'me@example.com'))
		).toBe(10);
		expect(
			total(groupMonthExpensesByCategory(rows, '2026-11', 'personal', 'me@example.com'))
		).toBe(20);
	});

	it('counts personal amounts and the user share of household rows, largest group first', () => {
		const rows = [
			row('p-1', '2026-10-02T02:00:00.000Z', 100, { category_id: 'food' }),
			row('h-1', '2026-10-03T02:00:00.000Z', 600, {
				scope: 'household',
				category_id: 'rent',
				shares_json: { 'me@example.com': 300, 'you@example.com': 300 }
			}),
			row('h-2', '2026-10-04T02:00:00.000Z', 50, {
				scope: 'household',
				category_id: null,
				shares_json: { 'you@example.com': 50 }
			})
		];

		const personal = groupMonthExpensesByCategory(
			rows,
			'2026-10',
			'personal',
			'me@example.com'
		);
		expect(personal.map((g) => [g.id, g.amount])).toEqual([
			['rent', 300],
			['food', 100],
			['uncategorized', 0]
		]);

		const household = groupMonthExpensesByCategory(
			rows,
			'2026-10',
			'household',
			'me@example.com'
		);
		expect(household.map((g) => g.id)).toEqual(['rent', 'uncategorized']);
		expect(household.flatMap((g) => g.items.map((i) => i.id))).toEqual(['h-1', 'h-2']);
	});
});
