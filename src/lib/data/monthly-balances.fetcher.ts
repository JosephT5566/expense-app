import { supabase } from '$lib/supabase/supabaseClient';
import type { MonthlyMemberBalance } from '$lib/types/monthly-balance';

export async function fetchMonthlyBalances(
	email: string,
	startMonth: string
): Promise<MonthlyMemberBalance[]> {
	const { data, error } = await supabase
		.from('v_monthly_member_balances')
		.select('month,scope,email,paid,owed,owed_by_category')
		.eq('email', email)
		.gte('month', `${startMonth}-01`)
		.returns<MonthlyMemberBalance[]>();
	if (error) {
		throw error;
	}
	return data ?? [];
}
