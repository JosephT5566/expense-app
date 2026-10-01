import { expect, test, type Page } from '@playwright/test';
import { loadEnv } from 'vite';

const env = loadEnv('production', process.cwd(), 'PUBLIC_');
const user = {
	id: '00000000-0000-4000-8000-000000000001',
	email: 'carousel@example.com',
	user_metadata: { name: 'Carousel Test' },
	aud: 'authenticated',
	role: 'authenticated'
};

test.use({ viewport: { width: 430, height: 900 }, timezoneId: 'Asia/Taipei' });

async function openHome(page: Page, failAugust = false) {
	await page.clock.setFixedTime(new Date('2026-10-01T12:00:00+08:00'));
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
	const requests: string[] = [];
	let shouldFailAugust = failAugust;
	await page.route(`${env.PUBLIC_SUPABASE_URL}/**`, async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith('/auth/v1/user')) {
			await route.fulfill({ json: user });
		} else if (url.pathname.endsWith('/rest/v1/app_settings')) {
			await route.fulfill({ json: [{ id: true, allowed_emails: [user.email] }] });
		} else if (url.pathname.endsWith('/rest/v1/expenses')) {
			const from =
				url.searchParams.getAll('ts').find((value) => value.startsWith('gte.')) ?? '';
			requests.push(from);
			// Let the neighbouring month finish first to exercise startup merge ordering.
			if (from.includes('2026-09-30')) {
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			if (from.includes('2026-07-31') && shouldFailAugust) {
				shouldFailAugust = false;
				await route.fulfill({ status: 500, json: { message: 'Test fetch failure' } });
				return;
			}
			// September has a row; other months are deliberately empty.
			const rows = from.includes('2026-08-31')
				? [
						{
							id: 'september-expense',
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
		} else {
			await route.fulfill({ json: [] });
		}
	});
	await page.goto('http://localhost:4173/');
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30_000
	});
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByLabel('Expense date')).toHaveValue('2026-10-01');
	// Wait for hydration and the initial carousel centering before interacting.
	await expectWindow(page, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
	return requests;
}

async function expectWindow(page: Page, dates: string[]) {
	await expect(page.locator('[data-date]')).toHaveCount(dates.length);
	await expect
		.poll(() =>
			page
				.locator('[data-date]')
				.evaluateAll((cards) => cards.map((card) => card.getAttribute('data-date')))
		)
		.toEqual(dates);
	const selected = await page.getByLabel('Expense date').inputValue();
	await expect
		.poll(async () => {
			const card = await page.locator(`[data-date="${selected}"]`).boundingBox();
			const viewport = await page.locator('[data-slot="carousel-content"]').boundingBox();
			return card && viewport
				? Math.abs(card.x + card.width / 2 - viewport.x - viewport.width / 2)
				: Infinity;
		})
		.toBeLessThan(3);
}

async function swipe(page: Page, direction: 'previous' | 'next') {
	const date = await page.getByLabel('Expense date').inputValue();
	const box = await page.locator(`[data-date="${date}"]`).boundingBox();
	if (!box) {
		throw new Error('Selected card is missing');
	}
	const from = direction === 'previous' ? 80 : 350;
	const to = direction === 'previous' ? 350 : 80;
	await page.mouse.move(from, box.y + 50);
	await page.mouse.down();
	await page.mouse.move(to, box.y + 50, { steps: 5 });
	await page.mouse.up();
}

test('date jumps and repeated swipes keep a centered bounded window across months and years', async ({
	page
}) => {
	test.setTimeout(60_000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const requests = await openHome(page);
	await expectWindow(page, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
	await swipe(page, 'previous');
	await expect(page.getByLabel('Expense date')).toHaveValue('2026-09-30');
	await expectWindow(page, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
	await expect(page.locator('[data-date="2026-09-30"]')).toContainText('September dinner');
	await swipe(page, 'previous');
	await expect(page.getByLabel('Expense date')).toHaveValue('2026-09-29');
	await expectWindow(page, [
		'2026-09-26',
		'2026-09-27',
		'2026-09-28',
		'2026-09-29',
		'2026-09-30',
		'2026-10-01'
	]);
	await swipe(page, 'next');
	await expect(page.getByLabel('Expense date')).toHaveValue('2026-09-30');
	await expectWindow(page, [
		'2026-09-27',
		'2026-09-28',
		'2026-09-29',
		'2026-09-30',
		'2026-10-01'
	]);
	await page.getByLabel('Expense date').fill('2026-08-01');
	await expectWindow(page, [
		'2026-07-29',
		'2026-07-30',
		'2026-07-31',
		'2026-08-01',
		'2026-08-02',
		'2026-08-03',
		'2026-08-04'
	]);
	await expect.poll(() => requests.some((value) => value.includes('2026-07-31'))).toBe(true);
	await page.getByLabel('Expense date').fill('2026-01-01');
	await expectWindow(page, [
		'2025-12-29',
		'2025-12-30',
		'2025-12-31',
		'2026-01-01',
		'2026-01-02',
		'2026-01-03',
		'2026-01-04'
	]);
	await swipe(page, 'previous');
	await expect(page.getByLabel('Expense date')).toHaveValue('2025-12-31');
	await expectWindow(page, [
		'2025-12-29',
		'2025-12-30',
		'2025-12-31',
		'2026-01-01',
		'2026-01-02',
		'2026-01-03',
		'2026-01-04'
	]);
	await page.getByRole('button', { name: 'Today', exact: true }).click();
	await expectWindow(page, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
	await expect(errors).toEqual([]);
});

test('empty months are remembered and failed month loads can be retried', async ({ page }) => {
	const requests = await openHome(page, true);
	await page.getByLabel('Expense date').fill('2026-08-15');
	await expectWindow(page, [
		'2026-08-12',
		'2026-08-13',
		'2026-08-14',
		'2026-08-15',
		'2026-08-16',
		'2026-08-17',
		'2026-08-18'
	]);
	const card = page.locator('[data-date="2026-08-15"]');
	await expect(card).toContainText('載入支出失敗');
	await card.getByRole('button', { name: '重試' }).click();
	await expect(card).toContainText('No Records');
	await page.getByLabel('Expense date').fill('2026-08-16');
	await expectWindow(page, [
		'2026-08-13',
		'2026-08-14',
		'2026-08-15',
		'2026-08-16',
		'2026-08-17',
		'2026-08-18',
		'2026-08-19'
	]);
	expect(requests.filter((value) => value.includes('2026-07-31'))).toHaveLength(2);
});

test('swipes reuse buffered DOM and data, edge shifts retain shared cards, and date jumps interrupt animation', async ({
	page
}) => {
	test.setTimeout(60_000);
	const requests = await openHome(page);
	await page.getByLabel('Expense date').fill('2026-08-15');
	const initialDates = [
		'2026-08-12',
		'2026-08-13',
		'2026-08-14',
		'2026-08-15',
		'2026-08-16',
		'2026-08-17',
		'2026-08-18'
	];
	await expectWindow(page, initialDates);
	await expect(page.locator('[data-date="2026-08-15"]')).toContainText('No Records');
	const retainedCard = await page.locator('[data-date="2026-08-15"]').elementHandle();
	if (!retainedCard) {
		throw new Error('Expected a buffered card');
	}
	await swipe(page, 'previous');
	await expect(page.getByLabel('Expense date')).toHaveValue('2026-08-14');
	await expectWindow(page, initialDates);
	expect(
		await retainedCard.evaluate(
			(node) => node.isConnected && node.getAttribute('data-date') === '2026-08-15'
		)
	).toBe(true);
	await swipe(page, 'previous');
	await expect(page.getByLabel('Expense date')).toHaveValue('2026-08-13');
	await expectWindow(page, [
		'2026-08-10',
		'2026-08-11',
		'2026-08-12',
		'2026-08-13',
		'2026-08-14',
		'2026-08-15',
		'2026-08-16'
	]);
	expect(
		await retainedCard.evaluate(
			(node) => node.isConnected && node.getAttribute('data-date') === '2026-08-15'
		)
	).toBe(true);
	expect(requests.filter((value) => value.includes('2026-07-31'))).toHaveLength(1);
	await page.getByLabel('Expense date').fill('2026-08-15');
	await expectWindow(page, initialDates);
	await swipe(page, 'previous');
	await expect(page.getByLabel('Expense date')).toHaveValue('2026-08-14');
	// Return to the unchanged anchor before waiting for the swipe to settle.
	await page.getByLabel('Expense date').fill('2026-08-15');
	await expectWindow(page, initialDates);
	await retainedCard.dispose();
});
