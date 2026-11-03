import { expect, type Page } from '@playwright/test';

export async function prepareSummaryTrend(
	page: Page,
	supabaseUrl = 'https://synthetic.supabase.co'
) {
	const user = {
		id: '00000000-0000-4000-8000-000000000002',
		email: 'summary@example.test',
		user_metadata: { name: 'Summary Test' },
		aud: 'authenticated',
		role: 'authenticated'
	};
	await page.clock.setFixedTime(new Date('2026-11-03T12:00:00+08:00'));
	await page.addInitScript(
		({ key, user }) => {
			localStorage.setItem(
				key,
				JSON.stringify({
					access_token: 'test-access-token',
					refresh_token: 'test-refresh-token',
					expires_at: 4102444800,
					expires_in: 3600,
					token_type: 'bearer',
					user
				})
			);
		},
		{ key: `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`, user }
	);
	const viewRequests: URL[] = [];
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === 'http://localhost:4173') {
			return route.continue();
		}
		if (url.origin !== supabaseUrl) {
			return route.abort();
		}
		if (url.pathname.endsWith('/auth/v1/user')) {
			return route.fulfill({ json: user });
		}
		if (url.pathname.endsWith('/rest/v1/app_settings')) {
			return route.fulfill({ json: [{ id: true, allowed_emails: [user.email] }] });
		}
		if (url.pathname.endsWith('/rest/v1/v_monthly_member_balances')) {
			viewRequests.push(url);
			return route.fulfill({
				json: [
					{
						month: '2026-09-01',
						scope: 'personal',
						email: user.email,
						paid: 100,
						owed: '100',
						owed_by_category: {}
					},
					{
						month: '2026-09-01',
						scope: 'household',
						email: user.email,
						paid: 100,
						owed: 200,
						owed_by_category: {}
					},
					{
						month: '2026-11-01',
						scope: 'personal',
						email: user.email,
						paid: 999,
						owed: 999,
						owed_by_category: {}
					}
				]
			});
		}
		if (url.pathname.endsWith('/rest/v1/expenses')) {
			const from = url.searchParams.getAll('ts').find((p) => p.startsWith('gte.')) ?? '';
			const november = from.includes('2026-10-31T16');
			const september = from.includes('2026-08-31T16');
			return route.fulfill({
				json:
					november || september
						? [
								{
									id: november ? 'nov' : 'sep',
									payer_email: user.email,
									note: november ? 'November gadget' : 'September food',
									amount: november ? 999 : 100,
									currency: 'TWD',
									ts: november ? '2026-11-01T04:00:00Z' : '2026-09-01T04:00:00Z',
									scope: 'personal',
									shares_json: {},
									category_id: null,
									is_settled: false
								},
								...(!november
									? [
											{
												id: 'sep-household',
												payer_email: user.email,
												note: 'September shared',
												amount: 400,
												currency: 'TWD',
												ts: '2026-09-02T04:00:00Z',
												scope: 'household',
												shares_json: { [user.email]: 200 },
												category_id: null,
												is_settled: false
											}
										]
									: [])
							]
						: []
			});
		}
		return route.fulfill({ json: [] });
	});
	return viewRequests;
}
export async function openSummary(page: Page) {
	await page.goto('http://localhost:4173/summary');
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30000
	});
	await expect(page.locator('section.card')).toContainText('999');
	await expect(page.getByRole('button', { name: '近 6 個月開銷' })).toBeVisible();
}
