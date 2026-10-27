// Daily carousel: open home, swipe to yesterday, jump to a failing month,
// retry, return to today. Mirrors e2e/daily-carousel.test.ts.
import { expect } from '@playwright/test';

const user = {
	id: '00000000-0000-4000-8000-000000000001',
	email: 'verify@example.test',
	user_metadata: { name: 'Verify' },
	aud: 'authenticated',
	role: 'authenticated'
};
let failAugustOnce = true;
const expenseQueries = [];

export default {
	mocks: {
		async supabase(route, url) {
			const path = url.pathname;
			if (path.endsWith('/auth/v1/user')) {
				await route.fulfill({ json: user });
				return 200;
			}
			if (path.endsWith('/rest/v1/app_settings')) {
				await route.fulfill({ json: [{ id: true, allowed_emails: [user.email] }] });
				return 200;
			}
			if (
				path.endsWith('/rest/v1/categories') ||
				path.endsWith('/rest/v1/scheduled_expenses')
			) {
				await route.fulfill({ json: [] });
				return 200;
			}
			if (path.endsWith('/rest/v1/expenses') && route.request().method() === 'GET') {
				const from = url.searchParams.getAll('ts').find((v) => v.startsWith('gte.')) ?? '';
				expenseQueries.push(from);
				if (from.includes('2026-07-31') && failAugustOnce) {
					failAugustOnce = false;
					await route.fulfill({
						status: 500,
						json: { message: 'verify: synthetic failure' }
					});
					return 500;
				}
				const rows = from.includes('2026-08-31')
					? [
							{
								id: 'verify-september-expense',
								payer_email: user.email,
								note: 'September dinner',
								amount: 100,
								currency: 'TWD',
								ts: '2026-09-30T10:00:00Z',
								scope: 'personal',
								shares_json: {},
								category_id: null,
								is_settled: false
							}
						]
					: [];
				await route.fulfill({ json: rows });
				return 200;
			}
			return false;
		}
	},

	async run({ page, state, hosts, step, evidence }) {
		const date = page.getByRole('textbox', { name: 'Expense date' });
		const card = (d) => page.locator(`section[data-date="${d}"]`);
		await page.clock.setFixedTime(new Date('2026-10-01T12:00:00+08:00'));
		const storageKey = `sb-${hosts.supabase.split('.')[0]}-auth-token`;
		await page.addInitScript(
			({ storageKey, user }) =>
				localStorage.setItem(
					storageKey,
					JSON.stringify({
						access_token: 'verify-access-token',
						refresh_token: 'verify-refresh-token',
						expires_at: 4102444800,
						expires_in: 3600,
						token_type: 'bearer',
						user
					})
				),
			{ storageKey, user }
		);

		await step('open home signed in', async () => {
			await page.goto(`${state.URL}/`);
			await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
				timeout: 30_000
			});
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(date).toHaveValue('2026-10-01');
			await expect(
				card('2026-10-01').getByRole('button', { name: '今日第一筆記帳' })
			).toBeVisible();
		});
		await evidence('01-home-today');

		await step('swipe to previous day shows its expense', async () => {
			const box = await card('2026-10-01').boundingBox();
			await page.mouse.move(80, box.y + 50);
			await page.mouse.down();
			await page.mouse.move(350, box.y + 50, { steps: 5 });
			await page.mouse.up();
			await expect(date).toHaveValue('2026-09-30');
			await expect(card('2026-09-30')).toContainText('September dinner');
		});
		await evidence('02-swiped-2026-09-30');

		await step('jump to a month whose load fails shows retry', async () => {
			await date.fill('2026-08-15');
			await expect(card('2026-08-15')).toContainText('載入支出失敗');
		});
		await evidence('03-august-load-error');

		await step('retry loads the empty month', async () => {
			await card('2026-08-15').getByRole('button', { name: '重試' }).click();
			await expect(card('2026-08-15')).toContainText('No Records');
			expect(expenseQueries.filter((q) => q.includes('2026-07-31'))).toHaveLength(2);
		});
		await evidence('04-august-retried');

		await step('Today returns to the current day', async () => {
			await page.getByRole('button', { name: 'Today', exact: true }).click();
			await expect(date).toHaveValue('2026-10-01');
			await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);
		});
		await evidence('05-back-to-today');
	}
};
