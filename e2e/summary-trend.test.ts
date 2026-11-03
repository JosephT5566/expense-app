import { expect, test } from '@playwright/test';
import { prepareSummaryTrend, openSummary } from './helpers/summary-trend';

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
