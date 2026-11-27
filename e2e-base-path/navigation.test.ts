import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const iconHosts = new Set(['api.iconify.design', 'api.simplesvg.com', 'api.unisvg.com']);
test.beforeEach(async ({ page }) => {
	page.on('request', (request) => {
		expect(iconHosts.has(new URL(request.url()).hostname), request.url()).toBe(false);
	});
});

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

async function prepareNavigation(page: Page, origin: string) {
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
	await expect(nav).toHaveCount(1);
	await expect(nav).toBeVisible();
}

async function expectActive(nav: Locator, label: string) {
	const active = nav.getByRole('link', { name: label, exact: true });
	await expect(nav.locator('a[aria-current]')).toHaveCount(1);
	await expect(active).toHaveAttribute('aria-current', 'page');
	await expect(nav.locator('a.selected')).toHaveCount(1);
	await expect(active).toHaveClass(/\bselected\b/);
}

for (const { name, viewport } of [
	{ name: 'mobile', viewport: { width: 390, height: 844 } },
	{ name: 'desktop', viewport: { width: 1280, height: 800 } }
]) {
	test.describe(name, () => {
		test.use({ viewport });
		test.beforeEach(async ({ page, baseURL }) => {
			if (!baseURL) {
				throw new Error('Navigation tests require use.baseURL');
			}
			await prepareNavigation(page, new URL(baseURL).origin);
		});

		test('AI entry page loads under the base path and returns home', async ({ page }) => {
			const nav = page.getByRole('navigation', { name: '主要導覽' });
			await page.goto('/expense-app/ai-entry');
			await expectReady(page, nav);
			await expectActive(nav, 'AI 記帳');
			await expect(page.getByRole('region', { name: 'AI 記帳', exact: true })).toBeVisible();
			if (name === 'mobile') {
				const composer = page
					.getByRole('textbox', { name: '記帳內容', exact: true })
					.locator('..');
				const gap = async () =>
					nav
						.evaluate((element) => element.getBoundingClientRect().top)
						.then(
							async (top) =>
								top -
								(await composer.evaluate(
									(element) => element.getBoundingClientRect().bottom
								))
						);
				await expect.poll(gap).toBeGreaterThanOrEqual(0);
				await expect.poll(gap).toBeLessThanOrEqual(12);
				// Override the shared safe-area input so production math drives both consumers.
				await page.addStyleTag({
					content: ':root { --safe-bottom: 34px; }'
				});
				await expect
					.poll(() => nav.evaluate((element) => element.getBoundingClientRect().bottom))
					.toBe(844 - 34 - 8);
				await expect(page.locator('main')).toHaveCSS('padding-bottom', '114px');
				await expect.poll(gap).toBeGreaterThanOrEqual(0);
				await expect.poll(gap).toBeLessThanOrEqual(12);
				const list = page.getByRole('region', { name: '本次對話', exact: true });
				await list.evaluate((element) => {
					const long = document.createElement('p');
					long.style.height = '3000px';
					element.appendChild(long);
					element.scrollTop = 500;
				});
				await expect
					.poll(() => list.evaluate((element) => element.scrollTop))
					.toBeGreaterThan(0);
				expect(await page.locator('main').evaluate((element) => element.scrollTop)).toBe(0);
				await expect.poll(gap).toBeLessThanOrEqual(12);
			}
			if (name === 'desktop') {
				const composerBottom = await page
					.getByRole('textbox', { name: '記帳內容', exact: true })
					.locator('..')
					.evaluate((element) => element.getBoundingClientRect().bottom);
				expect(viewport.height - composerBottom).toBeGreaterThanOrEqual(0);
				expect(viewport.height - composerBottom).toBeLessThanOrEqual(28);
			}
			await nav.getByRole('link', { name: '新增', exact: true }).click();
			await expect(page).toHaveURL('/expense-app/');
			await expectActive(page.getByRole('navigation', { name: '主要導覽' }), '新增');
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
			const nav = page.getByRole('navigation', { name: '主要導覽' });
			await page.goto('/expense-app/');
			await expectReady(page, nav);
			await expectActive(nav, '新增');
			if (name === 'mobile') {
				await expect(nav).toHaveCSS('position', 'fixed');
			} else {
				const box = await nav.boundingBox();
				expect(box).not.toBeNull();
				expect(box?.x).toBeLessThan(300);
				expect(box?.height).toBeGreaterThan(400);
			}
			await expect(nav.getByRole('link')).toHaveCount(4);
			for (const label of ['新增', 'AI 記帳', '統計', '更多功能']) {
				const link = nav.getByRole('link', { name: label, exact: true });
				await expect(link).toHaveAccessibleName(label);
				if (name === 'mobile') {
					await expect(link.locator('svg')).toHaveCSS('width', '22px');
					await expect(link.locator('svg')).toHaveCSS('height', '22px');
					const bar = await nav.boundingBox();
					expect(bar!.height).toBe(64);
					expect(bar!.x).toBeCloseTo(14, 0);
					expect(viewport.width - bar!.x - bar!.width).toBeCloseTo(14, 0);
					expect(viewport.height - bar!.y - bar!.height).toBeGreaterThanOrEqual(8);
				} else {
					const ai = label === 'AI 記帳';
					await expect(link.locator('svg')).toHaveCSS('width', ai ? '32px' : '24px');
				}

				if (name === 'mobile') {
					await expect(link.getByText(label, { exact: true })).toBeVisible();
					const box = await link.boundingBox();
					expect(box?.width).toBeGreaterThanOrEqual(44);
					expect(box?.height).toBeGreaterThanOrEqual(44);
				} else {
					await expect(link.getByText(label, { exact: true })).toBeVisible();
				}
			}
			await page.evaluate(() => {
				window.__navMarker = 'alive';
			});
			const initialDocumentRequests = documentRequests;
			expect(initialDocumentRequests).toBeGreaterThan(0);

			for (const [label, pathname] of [
				['AI 記帳', '/expense-app/ai-entry'],
				['統計', '/expense-app/summary'],
				['更多功能', '/expense-app/setting'],
				['新增', '/expense-app/']
			]) {
				await nav.getByRole('link', { name: label, exact: true }).click();
				await expect(page).toHaveURL((url) => url.pathname === pathname);
				await expectReady(page, nav);
				await expectActive(nav, label);
				if (pathname === '/expense-app/setting') {
					await expect(
						page.getByRole('link', { name: '分帳', exact: true }).locator('svg')
					).toBeVisible();
					await expect(
						page.getByRole('link', { name: '搜尋', exact: true }).locator('svg')
					).toBeVisible();
				}
				expect(await page.evaluate(() => window.__navMarker)).toBe('alive');
				expect(documentRequests).toBe(initialDocumentRequests);
			}
		});

		if (name === 'mobile') {
			test('drag the selected pill across tabs and keep the links available in CSS mode', async ({
				page
			}) => {
				const cdp = await page.context().newCDPSession(page);
				await cdp.send('Emulation.setEmulatedMedia', {
					features: [
						{ name: 'prefers-reduced-transparency', value: 'reduce' },
						{ name: 'prefers-reduced-motion', value: 'reduce' }
					]
				});
				const nav = page.getByRole('navigation', { name: '主要導覽' });
				await page.goto('/expense-app/');
				await expectReady(page, nav);
				await expectActive(nav, '新增');
				await expect(nav).toHaveCSS('backdrop-filter', 'none');
				await expect(nav.locator('canvas')).toHaveCount(0);

				const center = async (label: string) => {
					const box = await nav
						.getByRole('link', { name: label, exact: true })
						.boundingBox();
					if (!box) {
						throw new Error('Cannot drag to a hidden nav link');
					}
					return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
				};

				const add = await center('新增');
				const setting = await center('更多功能');
				await page.mouse.move(add.x, add.y);
				await page.mouse.down();
				await page.mouse.move(setting.x, setting.y, { steps: 8 });
				await expect(nav).toHaveClass(/\bdragging\b/);
				await expectActive(nav, '新增');
				await expect(page).toHaveURL('/expense-app/');
				await page.mouse.up();
				await expect(page).toHaveURL('/expense-app/setting');
				await expectActive(nav, '更多功能');

				// A release outside the bar restores the active pill.
				await page.mouse.move(setting.x, setting.y);
				await page.mouse.down();
				await page.mouse.move(add.x, add.y, { steps: 8 });
				await page.mouse.move(add.x, add.y - 90);
				await page.mouse.up();
				await expect(nav).not.toHaveClass(/\bdragging\b/);
				await expectActive(nav, '更多功能');
				await expect(page).toHaveURL('/expense-app/setting');

				// Vertical motion does not initiate a horizontal drag.
				await page.mouse.move(setting.x, setting.y);
				await page.mouse.down();
				await page.mouse.move(setting.x + 2, setting.y - 18);
				await expect(nav).not.toHaveClass(/\bdragging\b/);
				await page.mouse.up();
				await expectActive(nav, '更多功能');
				await expect(page).toHaveURL('/expense-app/setting');

				await nav.getByRole('link', { name: '統計', exact: true }).click();
				await expectActive(nav, '統計');
				await expect(page).toHaveURL('/expense-app/summary');
				const aiEntry = nav.getByRole('link', { name: 'AI 記帳', exact: true });
				await aiEntry.focus();
				await aiEntry.press('Enter');
				await expectActive(nav, 'AI 記帳');
				await expect(page).toHaveURL('/expense-app/ai-entry');
			});
		}

		test('tab navigation resets the main scroll container', async ({ page }) => {
			const nav = page.getByRole('navigation', { name: '主要導覽' });
			const main = page.locator('main');
			await page.goto('/expense-app/');
			await expectReady(page, nav);
			await main.evaluate((element) => {
				const spacer = document.createElement('div');
				spacer.style.height = '3000px';
				element.appendChild(spacer);
				element.scrollTop = 500;
			});
			await expect
				.poll(() => main.evaluate((element) => element.scrollTop))
				.toBeGreaterThan(0);

			await nav.getByRole('link', { name: '統計', exact: true }).click();
			await expect(page).toHaveURL((url) => url.pathname === '/expense-app/summary');
			await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
		});

		for (const pathname of ['/settle', '/search', '/scheduled']) {
			test(`direct ${pathname} entry selects the setting section`, async ({ page }) => {
				const nav = page.getByRole('navigation', { name: '主要導覽' });
				await page.goto(`/expense-app${pathname}`);
				await expectReady(page, nav);
				await expect(page).toHaveURL((url) => url.pathname === `/expense-app${pathname}`);
				await expect(nav.locator('a[aria-current]')).toHaveCount(1);
				await expect(nav.locator('a[aria-current="page"]')).toHaveCount(0);
				const setting = nav.getByRole('link', { name: '更多功能', exact: true });
				await expect(setting).toHaveAttribute('aria-current', 'true');
				await expect(setting).toHaveClass(/\bselected\b/);
				await expect(nav.locator('a.selected')).toHaveCount(1);
				const aiEntry = nav.getByRole('link', { name: 'AI 記帳', exact: true });
				await expect(aiEntry).not.toHaveClass(/\bselected\b/);
				await expect(aiEntry).not.toHaveAttribute('aria-current');
				await expect(nav.getByRole('link', { name: '新增', exact: true })).not.toHaveClass(
					/\bselected\b/
				);
			});
		}

		test('direct summary entry selects summary', async ({ page }) => {
			const nav = page.getByRole('navigation', { name: '主要導覽' });
			await page.goto('/expense-app/summary');
			await expectReady(page, nav);
			await expect(page).toHaveURL((url) => url.pathname === '/expense-app/summary');
			await expectActive(nav, '統計');
		});

		test('base root without a trailing slash selects add', async ({ page }) => {
			const nav = page.getByRole('navigation', { name: '主要導覽' });
			await page.goto('/expense-app');
			await expectReady(page, nav);
			await expectActive(nav, '新增');
		});
	});
}
