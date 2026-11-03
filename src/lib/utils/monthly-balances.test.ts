import { describe, expect, it } from 'vitest';
import { balanceSeries, recentTaiwanMonths, switchMonthLabel } from './monthly-balances';
import type { MonthlyMemberBalance } from '$lib/types/monthly-balance';
import type { ExpenseRow } from '$lib/types/expense';
import { groupMonthExpensesByCategory } from './summary';

const months = recentTaiwanMonths('2026-02-10T00:00:00Z');
const balance = (
	owed: number | string,
	scope: 'personal' | 'household' = 'personal'
): MonthlyMemberBalance => ({
	month: '2026-02-01',
	scope,
	email: 'me@example.test',
	paid: 9999,
	owed,
	owed_by_category: null
});
describe('monthly balance series', () => {
	it('uses six Taiwan months across years and UTC month boundaries', () => {
		expect(months).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
		expect(recentTaiwanMonths('2026-01-31T15:59:59Z').at(-1)).toBe('2026-01');
		expect(recentTaiwanMonths('2026-01-31T16:00:00Z').at(-1)).toBe('2026-02');
		expect(recentTaiwanMonths('2026-02-01T00:00:00Z').at(-1)).toBe('2026-02');
	});
	it.each(['1234', 1234, '33.34'])('preserves numeric %s without rounding', (owed) => {
		expect(balanceSeries([balance(owed)], months, 'personal').at(-1)?.amount).toBe(
			Number(owed)
		);
	});
	it('zero fills, excludes outside months, and recomputes tab totals from owed', () => {
		const rows = [
			balance(100),
			balance('40', 'household'),
			{ ...balance(700), month: '2025-08-01' },
			{ ...balance(800), month: '2026-03-01' }
		];
		expect(balanceSeries(rows, months, 'personal').map((p) => p.amount)).toEqual([
			0, 0, 0, 0, 0, 140
		]);
		expect(balanceSeries(rows, months, 'household').map((p) => p.amount)).toEqual([
			0, 0, 0, 0, 0, 40
		]);
		expect(balanceSeries(rows, months, 'personal').at(-1)?.amount).toBe(140);
	});
	it('matches actual Summary grouping for integer personal and household shares including uncategorized', () => {
		const base: ExpenseRow = {
			id: 'p',
			payer_email: 'me@example.test',
			note: 'test',
			amount: 1234,
			currency: 'TWD',
			ts: '2026-02-01T00:00:00Z',
			scope: 'personal',
			shares_json: {},
			category_id: null,
			meta: '',
			created_at: '',
			updated_at: '',
			is_settled: false
		};
		const rows = [
			base,
			{
				...base,
				id: 'h',
				scope: 'household' as const,
				amount: 200,
				shares_json: { 'me@example.test': 80, 'partner@example.test': 120 },
				category_id: 'food'
			}
		];
		for (const scope of ['personal', 'household'] as const) {
			const total = groupMonthExpensesByCategory(
				rows,
				'2026-02',
				scope,
				'me@example.test'
			).reduce((n, g) => n + g.amount, 0);
			expect(
				balanceSeries([balance('1234'), balance(80, 'household')], months, scope).at(-1)
					?.amount
			).toBe(total);
		}
	});
	it('requires explicit switching and labels the current month', () => {
		expect(switchMonthLabel(null, '2026-02')).toBe('點選圖上的月份');
		expect(switchMonthLabel('2026-01', '2026-02')).toBe('切換到 2026/1 →');
		expect(switchMonthLabel('2026-02', '2026-02')).toBe('目前正在檢視 2026/2');
	});
});
