import { beforeEach, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => ({ select: vi.fn(), eq: vi.fn(), gte: vi.fn(), returns: vi.fn() }));
const from = vi.hoisted(() => vi.fn());
vi.mock('$lib/supabase/supabaseClient', () => ({ supabase: { from } }));
import { fetchMonthlyBalances } from './monthly-balances.fetcher';
beforeEach(() => {
	vi.clearAllMocks();
	from.mockReturnValue(query);
	query.select.mockReturnValue(query);
	query.eq.mockReturnValue(query);
	query.gte.mockReturnValue(query);
});
it('makes one user-filtered view request and preserves numeric values for the converter', async () => {
	const rows = [
		{
			month: '2026-11-01',
			scope: 'personal',
			email: 'me@example.test',
			paid: 0,
			owed: '33.34',
			owed_by_category: null
		}
	];
	query.returns.mockResolvedValue({ data: rows, error: null });
	expect(await fetchMonthlyBalances('me@example.test', '2026-06')).toEqual(rows);
	expect(from).toHaveBeenCalledExactlyOnceWith('v_monthly_member_balances');
	expect(query.select).toHaveBeenCalledWith('month,scope,email,paid,owed,owed_by_category');
	expect(query.eq).toHaveBeenCalledWith('email', 'me@example.test');
	expect(query.gte).toHaveBeenCalledWith('month', '2026-06-01');
});
it('surfaces query failure instead of displaying an empty successful result', async () => {
	query.returns.mockResolvedValue({ data: null, error: new Error('offline') });
	await expect(fetchMonthlyBalances('me@example.test', '2026-06')).rejects.toThrow('offline');
});
