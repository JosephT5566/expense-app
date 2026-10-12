import { expect, test, type Page, type Route } from '@playwright/test';
import { loadEnv } from 'vite';
const env = loadEnv('production', process.cwd(), 'PUBLIC_');
const endpoint =
	process.env.PUBLIC_SEMANTIC_ENTRY_URL ??
	env.PUBLIC_SEMANTIC_ENTRY_URL ??
	'https://semantic.example.test';
const basePath = process.env.E2E_BASE_PATH ?? '';
const user = {
	id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	email: 'a@example.test',
	aud: 'authenticated',
	role: 'authenticated',
	user_metadata: { name: 'Synthetic' }
};
const row = {
	id: '22222222-2222-4222-8222-222222222222',
	note: '語意午餐',
	amount: 100,
	currency: 'TWD',
	ts: '2026-10-01T04:00:00Z',
	payer_email: user.email,
	scope: 'personal',
	shares_json: { [user.email]: 100 },
	category_id: null,
	is_settled: true,
	meta: '',
	created_at: '2026-10-01T04:00:00Z',
	updated_at: '2026-10-01T04:00:00Z'
};
const created = (requestId: string, replayed = false) => ({
	status: 'created',
	requestId,
	expense: row,
	replayed,
	metadata: {
		model: 'synthetic',
		promptVersion: 'semantic-entry-v1',
		inputTokens: null,
		outputTokens: null,
		elapsedMs: 1
	}
});
test.use({ viewport: { width: 430, height: 900 }, timezoneId: 'Asia/Taipei' });
async function setup(
	page: Page,
	handler: (route: Route, body: { requestId: string; text: string } | null) => Promise<void>,
	initialRows: (typeof row)[] = []
) {
	await page.clock.setFixedTime(new Date('2026-10-01T12:00:00+08:00'));
	const storageKey = `sb-${new URL(env.PUBLIC_SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
	const session = {
		access_token: 'synthetic-jwt',
		refresh_token: 'synthetic-refresh',
		expires_at: 4102444800,
		expires_in: 3600,
		token_type: 'bearer',
		user
	};
	await page.addInitScript(
		({ storageKey, session }) => localStorage.setItem(storageKey, JSON.stringify(session)),
		{ storageKey, session }
	);
	let rows = initialRows;
	let writes = 0;
	const posts: { requestId: string; text: string }[] = [];
	await page.route(`${env.PUBLIC_SUPABASE_URL}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/auth/v1/user')) {
			await route.fulfill({ json: user });
		} else if (path.endsWith('/rest/v1/app_settings')) {
			await route.fulfill({ json: [{ id: true, allowed_emails: [user.email] }] });
		} else if (path.endsWith('/rest/v1/expenses')) {
			if (route.request().method() !== 'GET') {
				writes++;
			}
			const url = new URL(route.request().url());
			const offset = Number(url.searchParams.get('offset') ?? 0);
			const limit = Number(url.searchParams.get('limit') ?? rows.length);
			await route.fulfill({ json: rows.slice(offset, offset + limit) });
		} else {
			await route.fulfill({ json: [] });
		}
	});
	await page.route(`${endpoint}/**`, async (route) => {
		expect(route.request().headers().authorization).toBe('Bearer synthetic-jwt');
		const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
		if (body) {
			posts.push(body);
		}
		await handler(route, body);
	});
	await page.goto(`http://localhost:4173${basePath}/`);
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30000
	});
	await page.getByRole('button', { name: '文字記帳', exact: true }).click();
	await page.getByLabel('記帳內容').fill('午餐100');
	return {
		posts,
		setRows: (next: (typeof row)[]) => {
			rows = next;
		},
		writes: () => writes,
		storageKey,
		session
	};
}
const submit = (page: Page) => page.getByRole('button', { name: '送出記帳', exact: true }).click();
test('one click automatically creates and patches store/cache without expense REST writes', async ({
	page
}) => {
	const s = await setup(page, async (route, body) => {
		await route.fulfill({ json: created(body!.requestId) });
	});
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts).toHaveLength(1);
	expect(s.writes()).toBe(0);
	await expect(page.getByRole('button', { name: '確認記帳' })).toHaveCount(0);
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toBeVisible();
	await page.reload();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toBeVisible();
});
test('rejection displays the reason and performs zero writes', async ({ page }) => {
	const s = await setup(page, async (route, body) => {
		await route.fulfill({
			status: 422,
			json: {
				status: 'rejected',
				requestId: body!.requestId,
				issues: [{ field: 'amount', code: 'missing' }]
			}
		});
	});
	await submit(page);
	await expect(page.getByText('未新增', { exact: true })).toBeVisible();
	await expect(page.getByText('金額：缺少必要資訊')).toBeVisible();
	expect(s.writes()).toBe(0);
});
test('double click sends one in-flight request', async ({ page }) => {
	let release!: () => void;
	const wait = new Promise<void>((r) => {
		release = r;
	});
	const s = await setup(page, async (route, body) => {
		await wait;
		await route.fulfill({ json: created(body!.requestId) });
	});
	await page
		.getByRole('button', { name: '送出記帳', exact: true })
		.evaluate((button: HTMLButtonElement) => {
			button.click();
			button.click();
		});
	await expect.poll(() => s.posts.length).toBe(1);
	release();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
});
test('uncertain retry keeps UUID and text; a new operation gets a new UUID', async ({ page }) => {
	let count = 0;
	const s = await setup(page, async (route, body) => {
		if (++count === 1) {
			await route.abort();
		} else {
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await expect(page.getByLabel('記帳內容')).toBeDisabled();
	await page.getByRole('button', { name: '重試同一請求' }).click();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts[1]).toEqual(s.posts[0]);
	await page.getByRole('button', { name: '新增另一筆' }).click();
	await page.getByLabel('記帳內容').fill('午餐100');
	await submit(page);
	await expect.poll(() => s.posts.length).toBe(3);
	expect(s.posts[2].requestId).not.toBe(s.posts[0].requestId);
});
test('not_found stays uncertain and a subsequent GET restores completion', async ({ page }) => {
	let query = 0;
	const s = await setup(page, async (route, body) => {
		if (body) {
			await route.abort();
		} else {
			const requestId = route.request().url().split('/').at(-1);
			await route.fulfill({
				json:
					++query === 1
						? { status: 'not_found', requestId }
						: { status: 'completed', requestId, expense: row, replayed: true }
			});
		}
	});
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: '查詢結果' }).click();
	await expect(page.getByText('尚未查到完成結果，仍待確認。')).toBeVisible();
	await page.getByRole('button', { name: '查詢結果' }).click();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts).toHaveLength(1);
	expect(s.writes()).toBe(0);
});
test('replay refreshes edited data rather than applying its old snapshot', async ({ page }) => {
	const edited = { ...row, note: '已編輯午餐' };
	const s = await setup(
		page,
		async (route, body) => {
			s.setRows([edited]);
			await route.fulfill({ json: created(body!.requestId, true) });
		},
		[edited]
	);
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('已編輯午餐', { exact: true })
	).toBeVisible();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toHaveCount(0);
});
test('replay removes a deleted expense from store and cache', async ({ page }) => {
	const s = await setup(
		page,
		async (route, body) => {
			s.setRows([]);
			await route.fulfill({ json: created(body!.requestId, true) });
		},
		[row]
	);
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toHaveCount(0);
	await page.reload();
	await expect(page.getByText('語意午餐', { exact: true })).toHaveCount(0);
});
test('closing during processing preserves uncertain recovery and discards late UI results', async ({
	page
}) => {
	let release!: () => void;
	const wait = new Promise<void>((r) => {
		release = r;
	});
	const s = await setup(page, async (route, body) => {
		await wait;
		await route.fulfill({ json: created(body!.requestId) }).catch(() => {});
	});
	await submit(page);
	await expect.poll(() => s.posts.length).toBe(1);
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	release();
	await page.getByRole('button', { name: '文字記帳', exact: true }).click();
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await expect(page.getByText('關閉視窗不會取消已接受的記帳。')).toBeVisible();
});
test('switching accounts discards an old response and pending input', async ({ page }) => {
	let release!: () => void;
	const wait = new Promise<void>((r) => {
		release = r;
	});
	const s = await setup(page, async (route, body) => {
		await wait;
		await route.fulfill({ json: created(body!.requestId) }).catch(() => {});
	});
	await submit(page);
	await expect.poll(() => s.posts.length).toBe(1);
	await page.evaluate(
		({ storageKey, session }) => {
			const next = {
				...session,
				user: {
					...session.user,
					id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
					email: 'b@example.test'
				}
			};
			localStorage.setItem(storageKey, JSON.stringify(next));
			const channel = new BroadcastChannel(storageKey);
			channel.postMessage({ event: 'SIGNED_IN', session: next });
			channel.close();
		},
		{ storageKey: s.storageKey, session: s.session }
	);
	await expect(page.getByLabel('記帳內容')).toHaveValue('');
	release();
	await expect(page.getByText('已新增', { exact: true })).toHaveCount(0);
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toHaveCount(0);
});

test('replay refresh reads beyond the first five hundred rows', async ({ page }) => {
	const rows = Array.from({ length: 501 }, (_, index) => ({
		...row,
		id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
		note: `合成項目${index + 1}`
	}));
	await setup(
		page,
		async (route, body) => {
			await route.fulfill({ json: created(body!.requestId, true) });
		},
		rows
	);
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('合成項目501', { exact: true })
	).toBeVisible();
});
test('account switch during replay refresh never applies an old-account response', async ({
	page
}) => {
	const s = await setup(page, async (route, body) => {
		await route.fulfill({ json: created(body!.requestId, true) });
	});
	let release!: () => void;
	const wait = new Promise<void>((r) => {
		release = r;
	});
	let started = false;
	await page.route(`${env.PUBLIC_SUPABASE_URL}/rest/v1/expenses?**`, async (route) => {
		if (!started) {
			started = true;
			await wait;
			await route.fulfill({ json: [row] });
		} else {
			await route.fulfill({ json: [] });
		}
	});
	await submit(page);
	await expect.poll(() => started).toBe(true);
	await page.evaluate(
		({ storageKey, session }) => {
			const next = {
				...session,
				user: {
					...session.user,
					id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
					email: 'b@example.test'
				}
			};
			localStorage.setItem(storageKey, JSON.stringify(next));
			const channel = new BroadcastChannel(storageKey);
			channel.postMessage({ event: 'SIGNED_IN', session: next });
			channel.close();
		},
		{ storageKey: s.storageKey, session: s.session }
	);
	await expect(page.getByLabel('記帳內容')).toHaveValue('');
	release();
	await expect(page.getByText('已新增', { exact: true })).toHaveCount(0);
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toHaveCount(0);
});
