import type { ExpenseScope } from './expense';

/** Selected columns of v_monthly_member_balances. PostgREST numeric may be a string. */
export interface MonthlyMemberBalance {
	month: string;
	scope: ExpenseScope;
	email: string;
	paid: number | string;
	owed: number | string;
	owed_by_category: Record<string, number | string> | null;
}
export type MonthlyBalancePoint = { month: string; amount: number };
