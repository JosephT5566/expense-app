import { expect, test } from '@playwright/test';
import {
	prepareSummaryTrend,
	openSummary,
	observeTrendRefresh,
	switchSummaryAccount
} from './helpers/summary-trend';

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL ?? 'https://synthetic.supabase.co';
test.use({
	viewport: { width: 390, height: 844 },
	timezoneId: 'Asia/Taipei',
	serviceWorkers: 'block'
});
test('selecting a trend point waits for Switch before changing pie and expense list', async ({
	page
}) => {
	const requests = await prepareSummaryTrend(page, supabaseUrl);
	await openSummary(page);
	const expand = page.getByRole('button', { name: '近 6 個月開銷' });
	const chart = page.getByRole('group', { name: '近半年開銷折線圖', exact: true });
	await expect(expand).toHaveAttribute('aria-expanded', 'false');
	await expect(chart).toHaveCount(0);
	expect(requests).toHaveLength(0);
	await expand.click();
	await expect(expand).toHaveAttribute('aria-expanded', 'true');
	await expect(chart).toBeVisible();
	await expect(page.getByRole('button', { name: '點選圖上的月份' })).toBeDisabled();
	const september = page.getByRole('button', { name: '2026/9 NT$300', exact: true });
	await september.click();
	await expect(page.getByRole('button', { name: '切換到 2026/9 →' })).toBeEnabled();
	const pie = page.locator('section.card svg[width="220"]');
	await expect(pie).toContainText('999');
	await expect(page.locator('section.card')).toContainText('999');
	await page.getByRole('button', { name: '切換到 2026/9 →' }).click();
	await expect(page.getByRole('button', { name: '目前正在檢視 2026/9' })).toBeDisabled();
	await expect(pie).toContainText('300');
	await expect(pie).not.toContainText('999');
	await page.getByRole('button', { name: /未分類/ }).click();
	await expect(page.locator('section.card')).toContainText('September food');
	await expect(page.locator('section.card')).toContainText('September shared');
	await page.getByRole('button', { name: '共同花費', exact: true }).click();
	await expect(
		page.getByRole('button', { name: '2026/9 NT$200（檢視中）', exact: true })
	).toBeVisible();
	await expect(pie).toContainText('200');
	await page
		.getByRole('button', { name: '2026/9 NT$200（檢視中）', exact: true })
		.press('ArrowRight');
	await expect(page.getByRole('button', { name: '切換到 2026/10 →' })).toBeEnabled();
	await expect(chart.locator('[aria-live="polite"]')).toContainText('2026/10，NT$0');
	expect(requests).toHaveLength(1);
	expect(requests[0].searchParams.get('email')).toBe('eq.summary@example.test');
	expect(requests[0].searchParams.get('month')).toBe('gte.2026-06-01');
	await expand.click();
	await expect(chart).toHaveCount(0);
	await expect(expand).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('button', { name: '切換到 2026/10 →' })).toHaveCount(0);
	await expect(page.locator('[aria-live="polite"]', { hasText: '已選取 2026/10' })).toHaveCount(
		0
	);
	await expand.click();
	await expect(chart).toBeVisible();
	await expect(page.getByText('載入近半年資料…')).toHaveCount(0);
	await expect(page.getByRole('button', { name: '點選圖上的月份' })).toBeDisabled();
	expect(requests).toHaveLength(1);
});

test('view failures leave the existing Summary usable and can retry', async ({ page }) => {
	await prepareSummaryTrend(page, supabaseUrl);
	await page.route('**/rest/v1/v_monthly_member_balances**', (route) =>
		route.fulfill({ status: 500, json: { message: 'synthetic failure' } })
	);
	await openSummary(page);
	await page.getByRole('button', { name: '近 6 個月開銷' }).click();
	await expect(page.getByText('無法載入近半年資料')).toBeVisible();
	await expect(page.locator('section.card svg[width="220"]')).toContainText('999');
	await page.unroute('**/rest/v1/v_monthly_member_balances**');
	await page.getByRole('button', { name: '重試', exact: true }).click();
	await expect(page.getByRole('button', { name: '2026/9 NT$300', exact: true })).toBeVisible();
});

for (const failRefresh of [false, true]) {
	test(`background requery preserves the chart and selection${failRefresh ? ' through failure and retry' : ''}`, async ({
		page
	}) => {
		await prepareSummaryTrend(page, supabaseUrl);
		let viewRequests = 0;
		page.on('request', (request) => {
			if (new URL(request.url()).pathname.endsWith('/rest/v1/v_monthly_member_balances')) {
				viewRequests += 1;
			}
		});
		await openSummary(page);
		await page.getByRole('button', { name: '近 6 個月開銷' }).click();
		const chart = page.getByRole('group', { name: '近半年開銷折線圖', exact: true });
		const selected = page.getByRole('button', { name: '2026/9 NT$300', exact: true });
		const switchButton = page.getByRole('button', { name: '切換到 2026/9 →' });
		await selected.click();
		await expect(switchButton).toBeEnabled();
		expect(viewRequests).toBe(1);
		const monitor = await observeTrendRefresh(page);
		let release = () => {};
		let pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let refreshes = 0;
		await page.route('**/rest/v1/v_monthly_member_balances**', async (route) => {
			const attempt = ++refreshes;
			await pending;
			if (failRefresh && attempt === 1) {
				await route.fulfill({
					status: 500,
					json: { message: 'synthetic revalidation failure' }
				});
			} else {
				await route.fulfill({
					json: [
						{
							month: '2026-09-01',
							scope: 'personal',
							email: 'summary@example.test',
							paid: 450,
							owed: 450,
							owed_by_category: {}
						}
					]
				});
			}
		});
		let deletes = 0;
		await page.route('**/rest/v1/expenses**', async (route) => {
			if (route.request().method() !== 'DELETE') {
				return route.fallback();
			}
			expect(new URL(route.request().url()).searchParams.get('id')).toBe('eq.nov');
			deletes += 1;
			await route.fulfill({ status: 204 });
		});
		try {
			await page.getByRole('button', { name: /未分類/ }).click();
			await page
				.locator('li.expense-item-row', { hasText: 'November gadget' })
				.getByRole('button', { name: 'Edit', exact: true })
				.click();
			page.once('dialog', (dialog) => dialog.accept());
			await page
				.getByRole('dialog')
				.getByRole('button', { name: '刪除', exact: true })
				.click();
			await expect.poll(() => refreshes).toBe(1);
			await expect.poll(() => viewRequests).toBe(2);
			expect(deletes).toBe(1);
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(chart).toBeVisible();
			await expect(selected).toHaveAttribute('aria-pressed', 'true');
			await expect(switchButton).toBeEnabled();
			release();
			if (failRefresh) {
				await expect(page.getByText('無法更新，顯示上次儲存的資料')).toBeVisible();
				pending = new Promise<void>((resolve) => {
					release = resolve;
				});
				await page.getByRole('button', { name: '重試', exact: true }).click();
				await expect.poll(() => refreshes).toBe(2);
				await expect.poll(() => viewRequests).toBe(3);
				await expect(chart).toBeVisible();
				await expect(selected).toHaveAttribute('aria-pressed', 'true');
				await expect(switchButton).toBeEnabled();
				release();
			}
			const updated = page.getByRole('button', { name: '2026/9 NT$450', exact: true });
			await expect(updated).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByRole('button', { name: '重試', exact: true })).toHaveCount(0);
			await expect
				.poll(() => monitor.evaluate(({ state }) => state))
				.toEqual({ chartRemoved: false, loadingShown: false });
			await expect(switchButton).toBeEnabled();
		} finally {
			release();
			await monitor.evaluate(({ stop }) => stop());
			await monitor.dispose();
		}
	});
}

test('account changes clear old rows and selection before the new response arrives', async ({
	page
}) => {
	await prepareSummaryTrend(page, supabaseUrl);
	await openSummary(page);
	await page.getByRole('button', { name: '近 6 個月開銷' }).click();
	await page.getByRole('button', { name: '2026/9 NT$300', exact: true }).click();
	await expect(page.getByRole('button', { name: '切換到 2026/9 →' })).toBeEnabled();
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const accounts: string[] = [];
	await page.route('**/rest/v1/v_monthly_member_balances**', async (route) => {
		accounts.push(new URL(route.request().url()).searchParams.get('email') ?? '');
		await pending;
		await route.fulfill({
			json: [
				{
					month: '2026-09-01',
					scope: 'personal',
					email: 'other@example.test',
					paid: 750,
					owed: 750,
					owed_by_category: {}
				}
			]
		});
	});
	try {
		await switchSummaryAccount(page, supabaseUrl);
		await expect.poll(() => accounts).toEqual(['eq.other@example.test']);
		await expect(page.getByText('載入近半年資料…')).toBeVisible();
		await expect(
			page.getByRole('group', { name: '近半年開銷折線圖', exact: true })
		).toHaveCount(0);
		await expect(page.getByRole('button', { name: '2026/9 NT$300', exact: true })).toHaveCount(
			0
		);
		release();
		await expect(
			page.getByRole('button', { name: '2026/9 NT$750', exact: true })
		).toHaveAttribute('aria-pressed', 'false');
		await expect(page.getByRole('button', { name: '點選圖上的月份' })).toBeDisabled();
	} finally {
		release();
	}
});
