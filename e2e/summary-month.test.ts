import { expect, test } from '@playwright/test';
import { setupSummaryColors, pickSummaryMonth } from './summary-colors.fixture';

test.use({ serviceWorkers: 'block' });

// Summary month switching with mocked Supabase only (PR #68 review finding 6).
const env = {
	PUBLIC_SUPABASE_URL: process.env.PUBLIC_SUPABASE_URL ?? 'https://verify-stub.invalid'
};
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
	await page.route('**/*', (route) =>
		new URL(route.request().url()).origin === 'http://localhost:4173'
			? route.continue()
			: route.abort()
	);
	await page.routeWebSocket('**/*', (socket) => socket.close());
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

test('summary hides legends and keeps category dots matched to chart colors across months and scopes', async ({
	page
}) => {
	await setupSummaryColors(page);
	const chart = page.getByRole('img', { name: '本月各類別花費佔比圖', exact: true });
	const section = page.locator('section.card');
	const dot = (id: string) => section.locator(`[data-category-id="${id}"] [data-category-dot]`);
	async function verifyColors() {
		await expect(chart).toBeVisible();
		await expect(section.locator('[data-category-dot]')).toHaveCount(3);
		for (const [id, label] of [
			['a', '合成餐飲'],
			['b', '合成交通']
		]) {
			// Category text appears only in the accordion, never in a duplicate legend.
			await expect(section.getByText(label, { exact: true })).toHaveCount(1);
			const stroke = await chart
				.locator(`path[data-category-label="${label}"]`)
				.getAttribute('stroke');
			expect(stroke).toBeTruthy();
			const background = await dot(id).evaluate((el) => el.style.backgroundColor);
			const normalizedStroke = await page.evaluate((color) => {
				const el = document.createElement('span');
				el.style.backgroundColor = color ?? '';
				return el.style.backgroundColor;
			}, stroke);
			expect(background).toBe(normalizedStroke);
			await expect(dot(id)).toHaveCSS('width', '4px');
			await expect(dot(id)).toHaveCSS('height', '4px');
			expect(
				await dot(id).evaluate((el) => parseFloat(getComputedStyle(el).borderRadius))
			).toBeGreaterThanOrEqual(2);
		}
		await expect(dot('z')).toHaveCSS('background-color', 'rgb(156, 163, 175)');
		await expect(chart.locator('path[data-category-label="合成零額"]')).toHaveCount(0);
	}
	await verifyColors();
	async function colors() {
		return Promise.all(
			['a', 'b'].map((id) => dot(id).evaluate((el) => el.style.backgroundColor))
		);
	}
	const original = await colors();
	await expect(section.locator('[data-category-id]').first()).toHaveAttribute(
		'data-category-id',
		'a'
	);
	await pickSummaryMonth(page, '2026/11', '2026-10');
	await expect(section.locator('[data-category-id]').first()).toHaveAttribute(
		'data-category-id',
		'b'
	);
	await verifyColors();
	expect(await colors()).toEqual(original);
	await page.getByRole('button', { name: '共同花費', exact: true }).click();
	await verifyColors();
	expect(await colors()).toEqual(original);
});
