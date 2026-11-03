import { expect, type Page } from '@playwright/test';

export async function pickSummaryMonth(page: Page, current: string, next: string) {
	const inline = page.locator('section.card input[type="month"]');
	if (await inline.count()) {
		await inline.fill(next);
	} else {
		await page.getByRole('button', { name: current, exact: true }).click();
		await page.getByRole('dialog').locator('input[type="month"]').fill(next);
		await page.getByRole('button', { name: '完成' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
	}
}

// Deliberately shuffled response: color assignment must use (sort_order, id).
export const summaryCategories = [
	{ id: 'z', name: '合成零額', kind: 'expense', sort_order: 10 },
	{ id: 'd', name: '合成購物', kind: 'expense', sort_order: 4 },
	{ id: 'b', name: '合成交通', kind: 'expense', sort_order: 2 },
	{ id: 'i', name: '合成醫療', kind: 'expense', sort_order: 9 },
	{ id: 'a', name: '合成餐飲', kind: 'expense', sort_order: 1 },
	{ id: 'h', name: '合成居家', kind: 'expense', sort_order: 8 },
	{ id: 'f', name: '合成學習', kind: 'expense', sort_order: 6 },
	{ id: 'c', name: '合成娛樂', kind: 'expense', sort_order: 3 },
	{ id: 'g', name: '合成旅遊', kind: 'expense', sort_order: 7 },
	{ id: 'e', name: '合成運動', kind: 'expense', sort_order: 5 }
];

export async function setupSummaryColors(page: Page) {
	const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
	if (
		!supabaseUrl ||
		(!/\.(invalid|test)$/.test(new URL(supabaseUrl).hostname) &&
			supabaseUrl !== 'https://synthetic.supabase.co')
	) {
		throw new Error('Summary mocks require a synthetic Supabase URL');
	}
	const user = {
		id: '00000000-0000-4000-8000-000000000002',
		email: 'summary@example.com',
		user_metadata: { name: 'Summary Test' },
		aud: 'authenticated',
		role: 'authenticated'
	};
	await page.clock.setFixedTime(new Date('2026-11-02T12:00:00+08:00'));
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
		{ storageKey: `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`, user }
	);
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === 'http://localhost:4173') {
			return route.continue();
		}
		if (url.origin !== new URL(supabaseUrl).origin) {
			return route.abort();
		}
		if (url.pathname.endsWith('/auth/v1/user')) {
			return route.fulfill({ json: user });
		}
		if (url.pathname.endsWith('/rest/v1/app_settings')) {
			return route.fulfill({ json: [{ id: true, allowed_emails: [user.email] }] });
		}
		if (url.pathname.endsWith('/rest/v1/categories')) {
			return route.fulfill({ json: summaryCategories });
		}
		if (url.pathname.endsWith('/rest/v1/expenses')) {
			const from = url.searchParams.getAll('ts').find((v) => v.startsWith('gte.')) ?? '';
			const november = from.includes('2026-10-31T16');
			const month = november ? '11' : '10';
			const amounts = november
				? [300, 100, 90, 80, 70, 60, 50, 40, 30, 0]
				: [100, 500, 40, 60, 20, 90, 10, 80, 30, 0];
			const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'z'].map((category, i) => ({
				id: `${month}-${category}`,
				payer_email: user.email,
				note: `合成項目 ${category}`,
				amount: amounts[i],
				currency: 'TWD',
				ts: `2026-${month}-01T04:00:00Z`,
				scope: 'household',
				shares_json: { [user.email]: amounts[i] },
				category_id: category,
				is_settled: false
			}));
			return route.fulfill({ json: rows });
		}
		return route.fulfill({ json: [] });
	});
	await page.routeWebSocket('**/*', (socket) => socket.close());
	await page.goto('http://localhost:4173/summary');
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30_000
	});
	await expect(page.locator('section.card')).toContainText('合成零額');
}
