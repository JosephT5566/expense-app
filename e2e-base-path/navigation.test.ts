import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const origin = 'http://localhost:4174';
const supabaseUrl = new URL(process.env.PUBLIC_SUPABASE_URL ?? 'https://synthetic.supabase.co');
const user = {
	id: '00000000-0000-4000-8000-000000000002',
	email: 'navigation@example.test',
	user_metadata: { name: 'Navigation Test' },
	aud: 'authenticated',
	role: 'authenticated'
};

declare global {
	interface Window {
		__navMarker?: string;
	}
}

async function prepareNavigation(page: Page) {
	await page.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.origin === origin) {
			return route.continue();
		}
		if (url.origin !== supabaseUrl.origin) {
			return route.abort();
		}
		if (url.pathname === '/auth/v1/user') {
			return route.fulfill({ json: user });
		}
		if (url.pathname === '/rest/v1/app_settings') {
			return route.fulfill({ json: [{ id: true, allowed_emails: [user.email] }] });
		}
		return route.fulfill({ json: [] });
	});
	await page.routeWebSocket('**/*', (socket) => socket.close());
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
		{ key: `sb-${supabaseUrl.hostname.split('.')[0]}-auth-token`, user }
	);
}

async function expectReady(page: Page, nav: Locator) {
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30_000
	});
	await expect(nav).toBeVisible();
}

async function expectActive(nav: Locator, label: string) {
	const active = nav.getByRole('link', { name: label, exact: true });
	await expect(nav.locator('a[aria-current]')).toHaveCount(1);
	await expect(active).toHaveAttribute('aria-current', 'page');
	await expect(nav.locator('a.selected')).toHaveCount(1);
	await expect(active).toHaveClass(/\bselected\b/);
}

for (const { name, viewport, selector } of [
	{ name: 'mobile', viewport: { width: 390, height: 844 }, selector: 'nav.fixed.bottom-0' },
	{ name: 'desktop', viewport: { width: 1280, height: 800 }, selector: 'nav.hidden.md\\:block' }
]) {
	test.describe(name, () => {
		test.use({ viewport });
		test.beforeEach(async ({ page }) => {
			await prepareNavigation(page);
		});

		test('base path navigation preserves the document and updates the active link', async ({
			page
		}) => {
			let documentRequests = 0;
			page.on('request', (request) => {
				if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
					documentRequests += 1;
				}
			});
			const nav = page.locator(selector);
			await page.goto('/expense-app/');
			await expectReady(page, nav);
			await expectActive(nav, '新增');
			await page.evaluate(() => {
				window.__navMarker = 'alive';
			});
			const initialDocumentRequests = documentRequests;
			expect(initialDocumentRequests).toBeGreaterThan(0);

			for (const [label, pathname] of [
				['統計', '/expense-app/summary'],
				['更多功能', '/expense-app/setting'],
				['新增', '/expense-app/']
			]) {
				await nav.getByRole('link', { name: label, exact: true }).click();
				await expect(page).toHaveURL((url) => url.pathname === pathname);
				await expectReady(page, nav);
				await expectActive(nav, label);
				expect(await page.evaluate(() => window.__navMarker)).toBe('alive');
				expect(documentRequests).toBe(initialDocumentRequests);
			}
		});

		test('direct summary entry selects summary', async ({ page }) => {
			const nav = page.locator(selector);
			await page.goto('/expense-app/summary');
			await expectReady(page, nav);
			await expect(page).toHaveURL((url) => url.pathname === '/expense-app/summary');
			await expectActive(nav, '統計');
		});

		test('base root without a trailing slash selects add', async ({ page }) => {
			const nav = page.locator(selector);
			await page.goto('/expense-app');
			await expectReady(page, nav);
			await expectActive(nav, '新增');
		});
	});
}
