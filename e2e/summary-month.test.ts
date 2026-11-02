import { expect, test } from '@playwright/test';
import { loadEnv } from 'vite';

// Summary month switching with mocked Supabase only (PR #68 review finding 6).
const env = loadEnv('production', process.cwd(), 'PUBLIC_');
const user = {
	id: '00000000-0000-4000-8000-000000000002',
	email: 'summary@example.com',
	user_metadata: { name: 'Summary Test' },
	aud: 'authenticated',
	role: 'authenticated'
};

test('switching back to an already-loaded empty month shows that month, not the previous one', async ({
	page
}) => {
	await page.clock.setFixedTime(new Date('2026-11-02T12:00:00+08:00'));
	const storageKey = `sb-${new URL(env.PUBLIC_SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
	await page.addInitScript(
		({ storageKey, user }) => {
			localStorage.setItem(
				storageKey,
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
		{ storageKey, user }
	);
	const monthRequests: string[] = [];
	await page.route(`${env.PUBLIC_SUPABASE_URL}/**`, async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith('/auth/v1/user')) {
			await route.fulfill({ json: user });
		} else if (url.pathname.endsWith('/rest/v1/app_settings')) {
			await route.fulfill({ json: [{ id: true, allowed_emails: [user.email] }] });
		} else if (url.pathname.endsWith('/rest/v1/expenses')) {
			const from =
				url.searchParams.getAll('ts').find((value) => value.startsWith('gte.')) ?? '';
			monthRequests.push(from);
			// November (Taiwan) starts at 2026-10-31T16:00Z and holds one 999 expense;
			// October is deliberately empty.
			const rows = from.includes('2026-10-31T16')
				? [
						{
							id: 'november-expense',
							payer_email: user.email,
							note: 'November gadget',
							amount: 999,
							currency: 'TWD',
							ts: '2026-11-01T04:00:00Z',
							scope: 'personal',
							shares_json: {},
							category_id: null,
							is_settled: false
						}
					]
				: [];
			await route.fulfill({ json: rows });
		} else {
			await route.fulfill({ json: [] });
		}
	});

	await page.goto('http://localhost:4173/summary');
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30_000
	});
	const list = page.locator('section.card');
	await expect(list).toContainText('999');

	async function pickMonth(current: string, next: string) {
		await page.getByRole('button', { name: current, exact: true }).click();
		await page.getByRole('dialog').locator('input[type="month"]').fill(next);
		await page.getByRole('button', { name: '完成' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
	}

	await pickMonth('2026/11', '2026-10');
	await expect(list).toContainText('本月無資料');
	await expect(list).not.toContainText('999');

	await pickMonth('2026/10', '2026-11');
	await expect(list).toContainText('999');
	await expect(list).not.toContainText('本月無資料');

	await pickMonth('2026/11', '2026-10');
	await expect(list).toContainText('本月無資料');
	await expect(list).not.toContainText('999');

	// Each month was fetched once; the switches back reused the loaded months.
	expect(monthRequests.filter((from) => from.includes('2026-10-31T16'))).toHaveLength(1);
	expect(monthRequests.filter((from) => from.includes('2026-09-30T16'))).toHaveLength(1);
});
