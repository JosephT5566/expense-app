import { getTaiwanMonthKey } from './dates';
import type { ExpenseScope } from '$lib/types/expense';
import type { MonthlyMemberBalance, MonthlyBalancePoint } from '$lib/types/monthly-balance';

export function recentTaiwanMonths(now?: string): string[] {
	const [year, month] = getTaiwanMonthKey(now).split('-').map(Number);
	return Array.from({ length: 6 }, (_, i) => {
		const date = new Date(Date.UTC(year, month - 6 + i, 1));
		return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
	});
}

function monthNumber(value: string): number {
	const [year, month] = value.split('-').map(Number);
	return year * 12 + month - 1;
}

export function balanceSeries(
	rows: MonthlyMemberBalance[],
	months: string[],
	scope: ExpenseScope
): MonthlyBalancePoint[] {
	return months.map((month) => ({
		month,
		amount: rows.reduce(
			(sum, row) =>
				monthNumber(row.month) === monthNumber(month) &&
				(scope === 'personal' || row.scope === 'household')
					? sum + Number(row.owed)
					: sum,
			0
		)
	}));
}

export function formatBalanceMonth(month: string): string {
	const [year, value] = month.split('-');
	return `${year}/${Number(value)}`;
}

// Keep fractions returned by the view; formatting must not introduce monetary rounding.
export function formatBalanceAmount(amount: number): string {
	return `NT$${amount.toLocaleString('en-US', { maximumFractionDigits: 20 })}`;
}

export function switchMonthLabel(selected: string | null, viewed: string): string {
	if (!selected) {
		return '點選圖上的月份';
	}
	return selected === viewed
		? `目前正在檢視 ${formatBalanceMonth(viewed)}`
		: `切換到 ${formatBalanceMonth(selected)} →`;
}
