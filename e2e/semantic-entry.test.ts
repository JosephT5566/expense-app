import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
	draftIssues,
	effectiveDrafts,
	fromServerDrafts,
	isComplete,
	toClientDraft
} from '../src/lib/components/semantic-entry/drafts';
import * as pendingStore from '../src/lib/components/semantic-entry/pending';
import {
	SERVICE_TEXT_DEADLINE_MS,
	SERVICE_IMAGE_DEADLINE_MS,
	CLOUD_RUN_TIMEOUT_MS,
	SEMANTIC_TIMEOUT_MS,
	SEMANTIC_IMAGE_TIMEOUT_MS
} from '../src/lib/components/semantic-entry/timeouts';
import type { Draft, SemanticRequestV3 } from '../packages/semantic-entry-contract/src/index';
const env = {
	PUBLIC_SUPABASE_URL: process.env.PUBLIC_SUPABASE_URL ?? 'https://synthetic.supabase.co'
};
const endpoint = process.env.PUBLIC_SEMANTIC_ENTRY_URL ?? 'https://semantic.example.test';
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
	expenses: [row],
	replayed,
	metadata: {
		model: 'synthetic',
		promptVersion: 'semantic-entry-v1',
		inputTokens: null,
		outputTokens: null,
		elapsedMs: 1
	}
});
let expenseWrites = 0;
test.beforeEach(() => {
	expenseWrites = 0;
});
test.afterEach(() => {
	expect(expenseWrites, 'semantic entry must never write expenses through REST').toBe(0);
});
test.use({ viewport: { width: 430, height: 900 }, timezoneId: 'Asia/Taipei' });
async function setup(
	page: Page,
	handler: (route: Route, body: SemanticRequestV3 | null) => Promise<void>,
	initialRows: (typeof row)[] = [],
	allowedEmails = [user.email, 'b@example.test'],
	clock: 'fixed' | 'install' = 'fixed'
) {
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (['localhost', '127.0.0.1'].includes(url.hostname)) {
			await route.continue();
		} else {
			await route.abort();
		}
	});
	if (clock === 'install') {
		// Fake timers from page load so runFor drives the 60-second expiry check and toasts.
		await page.clock.install({ time: new Date('2026-10-01T12:00:00+08:00') });
	} else {
		await page.clock.setFixedTime(new Date('2026-10-01T12:00:00+08:00'));
	}
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
	const posts: SemanticRequestV3[] = [];
	await page.route(`${env.PUBLIC_SUPABASE_URL}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/auth/v1/user')) {
			await route.fulfill({ json: user });
		} else if (path.endsWith('/rest/v1/app_settings')) {
			await route.fulfill({
				json: [{ id: true, allowed_emails: allowedEmails }]
			});
		} else if (path.endsWith('/rest/v1/categories')) {
			await route.fulfill({
				json: [
					{ id: categoryId, name: '合成餐飲', kind: 'expense', sort_order: 1 },
					{
						id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
						name: '合成交通',
						kind: 'expense',
						sort_order: 2
					}
				]
			});
		} else if (path.endsWith('/rest/v1/expenses')) {
			if (route.request().method() !== 'GET') {
				writes++;
				expenseWrites++;
			}
			const url = new URL(route.request().url());
			const offset = Number(url.searchParams.get('offset') ?? 0);
			const limit = Number(url.searchParams.get('limit') ?? rows.length);
			// Buffered days fetch neighbouring months too. Match PostgREST date filters
			// before pagination so October rows cannot enter September's cache.
			const bounds = url.searchParams.getAll('ts');
			const matching = rows.filter((row) =>
				bounds.every((bound) => {
					const separator = bound.indexOf('.');
					const operator = bound.slice(0, separator);
					const value = Date.parse(bound.slice(separator + 1));
					return operator === 'gte'
						? Date.parse(row.ts) >= value
						: operator === 'lte'
							? Date.parse(row.ts) <= value
							: true;
				})
			);
			await route.fulfill({ json: matching.slice(offset, offset + limit) });
		} else {
			await route.fulfill({ json: [] });
		}
	});
	await page.route(`${endpoint}/**`, async (route) => {
		expect(route.request().headers().authorization).toBe('Bearer synthetic-jwt');
		const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
		if (body) {
			expect(['analyze', 'revise', 'commit']).toContain(body.action);
			expect(route.request().headers().accept).toBe('text/event-stream; semantic-version=3');
			posts.push(body);
		}
		if (!body) {
			expect(route.request().headers().accept).toBe('application/json; semantic-version=3');
		}
		await handler(route, body);
	});
	await page.goto(`http://localhost:4173${basePath}/`);
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30000
	});
	const selectedDay = await page.getByRole('textbox', { name: 'Expense date' }).inputValue();
	await page
		.locator(`[data-date="${selectedDay}"]`)
		.getByRole('button', { name: 'AI 記帳', exact: true })
		.click();
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
const interrupted = (route: Route, requestId: string) =>
	route.fulfill({
		contentType: 'text/event-stream',
		body: `event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId })}\n\n`
	});
const submit = (page: Page) => page.getByRole('button', { name: '送出記帳', exact: true }).click();
// Pending tray (variant A): the title badge opens a popover; rows expand in place.
const pendingBadge = (page: Page) => page.getByRole('button', { name: /^待確認( \d+ 筆)?$/ });
const pendingTray = (page: Page) => page.locator('#semantic-pending-tray');
const trayRows = (page: Page) => pendingTray(page).getByRole('listitem');
async function openPendingTray(page: Page) {
	if (!(await pendingTray(page).isVisible())) {
		await pendingBadge(page).click();
	}
	await expect(pendingTray(page)).toBeVisible();
}
async function expandPending(page: Page, index = 0) {
	await openPendingTray(page);
	const toggle = trayRows(page).nth(index).locator('button[aria-expanded]');
	if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
		await toggle.click();
	}
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
async function trayAction(
	page: Page,
	name: '查詢結果' | '重試同一請求' | '刪除這筆待確認',
	index = 0
) {
	await expandPending(page, index);
	await trayRows(page).nth(index).getByRole('button', { name, exact: true }).click();
}
const createdSummary = (page: Page) => page.getByRole('group', { name: '已記帳摘要' });
const limitToast = (page: Page) =>
	page.getByRole('status').filter({ hasText: '已有3筆待確認，暫時無法建立新對話' });
async function cachedMonth(page: Page, month: string) {
	return page.evaluate(
		(key) =>
			new Promise<unknown>((resolve, reject) => {
				const opening = indexedDB.open('keyval-store');
				opening.onerror = () => reject(opening.error);
				opening.onsuccess = () => {
					const db = opening.result;
					const transaction = db.transaction('keyval', 'readonly');
					const request = transaction.objectStore('keyval').get(key);
					transaction.oncomplete = () => {
						db.close();
						resolve(request.result?.data ?? null);
					};
					transaction.onabort = () => {
						db.close();
						reject(transaction.error);
					};
				};
			}),
		`monthly-expenses:${month}`
	);
}
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
			await interrupted(route, body!.requestId);
		} else {
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await expect(page.getByLabel('記帳內容')).toBeEditable();
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	await trayAction(page, '重試同一請求');
	await expect(pendingTray(page)).toHaveCount(0);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await expect(pendingBadge(page)).toHaveCount(0);
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
			await interrupted(route, body!.requestId);
		} else {
			const requestId = route.request().url().split('/').at(-1);
			await route.fulfill({
				json:
					++query === 1
						? { status: 'not_found', requestId }
						: { status: 'completed', requestId, expenses: [row], replayed: true }
			});
		}
	});
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await trayAction(page, '查詢結果');
	await expect.poll(() => query).toBe(1);
	await expect(trayRows(page).first()).toContainText('尚未查到完成結果。');
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	await trayAction(page, '查詢結果');
	await expect(createdSummary(page)).toContainText('已記帳 1 筆');
	await expect(pendingBadge(page)).toHaveCount(0);
	expect(await pending(page)).toBeNull();
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
	await expect.poll(() => cachedMonth(page, '2026-10')).toEqual([row]);
	await expect.poll(() => cachedMonth(page, '2026-09')).toEqual([]);
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toHaveCount(0);
	await expect.poll(() => cachedMonth(page, '2026-10')).toEqual([]);
	await page.reload();
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0);
	await expect.poll(() => cachedMonth(page, '2026-10')).toEqual([]);
	await expect(page.getByText('語意午餐', { exact: true })).toHaveCount(0);
});
test('processing locks close, Escape and outside interaction until completion', async ({
	page
}) => {
	let release!: () => void;
	const wait = new Promise<void>((r) => {
		release = r;
	});
	const s = await setup(page, async (route, body) => {
		await wait;
		await route.fulfill({ json: created(body!.requestId) });
	});
	await submit(page);
	await expect.poll(() => s.posts.length).toBe(1);
	await expect(
		page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
	).toHaveCount(0);
	await page.keyboard.press('Escape');
	// Bits UI debounces outside pointerdown by 10ms. Flush that callback while
	// the request is still pending, before releasing the mocked response.
	await page.clock.install({ time: new Date('2026-10-01T12:00:00+08:00') });
	await page.mouse.click(2, 2);
	await page.clock.runFor(20);
	await expect(page.getByRole('dialog')).toBeVisible();
	release();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
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
for (const status of [422, 429, 502]) {
	test(`uncertain retry with ${status} cannot erase the original uncertainty`, async ({
		page
	}) => {
		let post = 0;
		const s = await setup(
			page,
			async (route, body) => {
				if (!body) {
					await route.fulfill({
						json: {
							status: 'completed',
							requestId: route.request().url().split('/').at(-1),
							expenses: [row],
							replayed: true
						}
					});
				} else if (++post === 1) {
					await interrupted(route, body!.requestId);
				} else {
					await route.fulfill({
						status,
						json:
							status === 422
								? {
										status: 'rejected',
										requestId: body.requestId,
										issues: [{ field: 'amount', code: 'missing' }]
									}
								: {
										error: {
											code:
												status === 429
													? 'quota_exceeded'
													: 'provider_error',
											uncertain: false
										}
									}
					});
				}
			},
			[row]
		);
		await submit(page);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await trayAction(page, '重試同一請求');
		await expect.poll(() => s.posts.length).toBe(2);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: '修改後重新送出' })).toHaveCount(0);
		await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
		expect(s.posts[1]).toEqual(s.posts[0]);
		await trayAction(page, '查詢結果');
		await expect(createdSummary(page)).toContainText('已記帳 1 筆');
		await expect(pendingBadge(page)).toHaveCount(0);
	});
}
for (const lifecycle of ['reload', 'navigate']) {
	test(`pending request survives ${lifecycle} with allowed metadata only and status lookup`, async ({
		page
	}) => {
		const s = await setup(page, async (route, body) => {
			if (body) {
				await interrupted(route, body!.requestId);
			} else {
				await route.fulfill({
					json: {
						status: 'completed',
						requestId: route.request().url().split('/').at(-1),
						expenses: [row],
						replayed: true
					}
				});
			}
		});
		await submit(page);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		if (lifecycle === 'reload') {
			await page.reload();
		} else {
			await page.goto(`http://localhost:4173${basePath}/summary`);
			await page.goto(`http://localhost:4173${basePath}/`);
		}
		await page
			.locator('[data-date="2026-10-01"]')
			.getByRole('button', { name: 'AI 記帳', exact: true })
			.click();
		await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
		await expect(page.getByLabel('記帳內容')).toHaveValue('');
		await expect(page.getByLabel('記帳內容')).toBeEditable();
		await expandPending(page);
		await expect(page.getByRole('button', { name: '重試同一請求' })).toHaveCount(0);
		await trayAction(page, '查詢結果');
		await expect(createdSummary(page)).toContainText('已記帳 1 筆');
		expect(await pending(page)).toBeNull();
		expect(s.posts).toHaveLength(1);
	});
}
test('unavailable pending-request storage prevents submitting a new operation', async ({
	page
}) => {
	const s = await setup(page, async (route, body) =>
		route.fulfill({ json: created(body!.requestId) })
	);
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key.startsWith('jopie:semantic-pending:')) {
				throw new Error('storage unavailable');
			}
			original.call(this, key, value);
		};
	});
	await submit(page);
	await expect(page.getByText('目前無法保留請求，請允許此網站儲存資料後再試。')).toBeVisible();
	expect(s.posts).toHaveLength(0);
});
test('pending recovery belongs to its account and returns when its owner signs back in', async ({
	page
}) => {
	const s = await setup(page, async (route, body) => interrupted(route, body!.requestId));
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	const originalItems = await pendingItems(page);
	const switchAccount = async (other: boolean) =>
		page.evaluate(
			({ storageKey, session, other }) => {
				const next = other
					? {
							...session,
							user: {
								...session.user,
								id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
								email: 'b@example.test'
							}
						}
					: session;
				localStorage.setItem(storageKey, JSON.stringify(next));
				const channel = new BroadcastChannel(storageKey);
				channel.postMessage({ event: 'SIGNED_IN', session: next });
				channel.close();
			},
			{ storageKey: s.storageKey, session: s.session, other }
		);
	await switchAccount(true);
	await expect(page.getByLabel('記帳內容')).toHaveValue('');
	await expect(page.getByText('結果待確認', { exact: true })).toHaveCount(0);
	await expect(pendingBadge(page)).toHaveCount(0);
	await switchAccount(false);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	await expect(page.getByLabel('記帳內容')).toHaveValue('');
	expect(await pendingItems(page)).toEqual(originalItems);
	expect(s.posts).toHaveLength(1);
});

test('clarification supplements the same request and automatically writes without draft approval', async ({
	page
}) => {
	const question = '這筆支出的金額是多少？';
	const s = await setup(page, async (route, body) => {
		expect(route.request().headers().accept).toBe('text/event-stream; semantic-version=3');
		const result = body!.history
			? created(body!.requestId)
			: {
					status: 'needs_input',
					requestId: body!.requestId,
					question,
					issues: [{ field: 'amount', code: 'missing' }]
				};
		await route.fulfill({
			contentType: 'text/event-stream',
			body: `event: result\ndata: ${JSON.stringify(result)}\n\n`
		});
	});
	await page.getByLabel('記帳內容').fill('午餐');
	await submit(page);
	await expect(page.getByText(question, { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '確認記帳' })).toHaveCount(0);
	await page.getByLabel('補充資訊').fill('100元');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts[1]).toEqual({ ...s.posts[0], history: [{ question, answer: '100元' }] });
	expect(s.writes()).toBe(0);
});
test('closing a clarification discards conversation and uses a new request ID', async ({
	page
}) => {
	const s = await setup(page, async (route, body) =>
		route.fulfill({
			json: {
				status: 'needs_input',
				requestId: body!.requestId,
				question: '金額是多少？',
				issues: [{ field: 'amount', code: 'missing' }]
			}
		})
	);
	await submit(page);
	await expect(page.getByLabel('補充資訊')).toBeVisible();
	await page.getByLabel('補充資訊').fill('未送出回答');
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await page
		.locator('[data-date="2026-10-01"]')
		.getByRole('button', { name: 'AI 記帳', exact: true })
		.click();
	await expect(page.getByLabel('記帳內容')).toHaveValue('');
	await expect(page.getByLabel('補充資訊')).toHaveCount(0);
	await page.getByLabel('記帳內容').fill('新的午餐');
	await submit(page);
	await expect.poll(() => s.posts.length).toBe(2);
	expect(s.posts[1].requestId).not.toBe(s.posts[0].requestId);
	expect(s.posts[1].history).toBeUndefined();
});
test('interrupted stream retains only allowed metadata and retry freezes the full answered payload', async ({
	page
}) => {
	let count = 0;
	const question = '金額是多少？';
	const s = await setup(page, async (route, body) => {
		if (++count === 1) {
			await route.fulfill({
				json: {
					status: 'needs_input',
					requestId: body!.requestId,
					question,
					issues: [{ field: 'amount', code: 'missing' }]
				}
			});
		} else if (count === 2) {
			await route.fulfill({
				contentType: 'text/event-stream',
				body: `event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId: body!.requestId })}\n\n`
			});
		} else {
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	await submit(page);
	await page.getByLabel('補充資訊').fill('100');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	const stored = await page.evaluate(
		(id) => JSON.parse(localStorage.getItem(`jopie:semantic-pending:${id}`)!),
		user.id
	);
	expect(stored).toEqual({
		v: 2,
		items: [
			{
				requestId: s.posts[1].requestId,
				submittedAt: expect.any(Number),
				kind: 'analyze',
				snippet: '午餐100',
				expiredAt: null
			}
		]
	});
	await trayAction(page, '重試同一請求');
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts[2]).toEqual(s.posts[1]);
});

test('live chunked SSE shows analysis then announces writing and locks the modal before returning the saved row', async ({
	page
}) => {
	const { createServer } = await import('node:http');
	let releaseAnalysis!: () => void;
	const analysisWait = new Promise<void>((resolve) => {
		releaseAnalysis = resolve;
	});
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = createServer(async (request, response) => {
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
		if (request.method === 'OPTIONS') {
			response.writeHead(204);
			response.end();
			return;
		}
		let body = '';
		for await (const chunk of request) {
			body += chunk;
		}
		const { requestId } = JSON.parse(body);
		response.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store'
		});
		const analysis = Buffer.from(
			`event: analysis_delta\ndata: ${JSON.stringify({ requestId, seq: 0, text: '辨識午餐🍜' })}\n\n`
		);
		const split = analysis.indexOf(Buffer.from('🍜')) + 1;
		response.write(analysis.subarray(0, split));
		await new Promise<void>((resolve) => setImmediate(resolve));
		response.write(analysis.subarray(split));
		await analysisWait;
		response.write(
			`event: analysis_delta\ndata: ${JSON.stringify({ requestId, seq: 1, text: '，準備驗證資料。' })}\n\n`
		);
		const frame = Buffer.from(
			`event: persisting\r\ndata: ${JSON.stringify({ status: 'persisting', requestId })}\r\n\r\n`
		);
		response.write(frame.subarray(0, frame.length - 1));
		await new Promise<void>((resolve) => setImmediate(resolve));
		response.write(frame.subarray(frame.length - 1));
		await wait;
		const result = Buffer.from(
			`event: result\ndata: ${JSON.stringify(created(requestId))}\n\n`
		);
		const offset = result.indexOf(Buffer.from('語意')) + 1;
		response.write(result.subarray(0, offset));
		await new Promise<void>((resolve) => setImmediate(resolve));
		response.end(result.subarray(offset));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as { port: number };
	try {
		await setup(page, async (route) => route.abort());
		await page.evaluate(
			({ endpoint, port }) => {
				const original = window.fetch;
				window.fetch = (input, init) => {
					const url = new URL(input instanceof Request ? input.url : String(input));
					return original(
						url.origin === new URL(endpoint).origin
							? `http://127.0.0.1:${port}${url.pathname}`
							: input,
						init
					);
				};
			},
			{ endpoint, port: address.port }
		);
		await submit(page);
		await expect(page.getByLabel('Gemini 分析摘要')).toHaveText('辨識午餐🍜');
		releaseAnalysis();
		await expect(page.getByLabel('Gemini 分析摘要')).toHaveText('辨識午餐🍜，準備驗證資料。');
		await expect(page.getByText('正在記帳，請稍候…', { exact: true })).toBeVisible();
		await expect(
			page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
		).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeVisible();
		release();
		await expect(page.getByText('已新增', { exact: true })).toBeVisible();
		await expect(
			page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
		).toBeVisible();
	} finally {
		releaseAnalysis();
		release();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

for (const fault of ['wrong-id', 'unknown-event', 'question-after-writing', 'explicit-error']) {
	test(`SSE ${fault} classifies recovery by persisting without applying expense data`, async ({
		page
	}) => {
		const s = await setup(page, async (route, body) => {
			const requestId = body!.requestId;
			const frames =
				fault === 'wrong-id'
					? `event: result\ndata: ${JSON.stringify(created('11111111-1111-4111-8111-111111111111'))}\n\n`
					: fault === 'unknown-event'
						? 'event: invented\ndata: {}\n\n'
						: `event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId })}\n\n` +
							(fault === 'explicit-error'
								? 'event: error\ndata: {"error":{"code":"service_error","uncertain":false}}\n\n'
								: `event: result\ndata: ${JSON.stringify({ status: 'needs_input', requestId, question: '金額？', issues: [{ field: 'amount', code: 'missing' }] })}\n\n`);
			await route.fulfill({ contentType: 'text/event-stream', body: frames });
		});
		await submit(page);
		await expect(
			page.getByText(
				['question-after-writing', 'explicit-error'].includes(fault)
					? '結果待確認'
					: '未新增',
				{ exact: true }
			)
		).toBeVisible();
		await expect(page.getByText('已新增', { exact: true })).toHaveCount(0);
		expect(s.writes()).toBe(0);
	});
}

for (const fault of ['gap', 'duplicate', 'wrong-id', 'oversize', 'after-writing']) {
	test(`analysis ${fault} classifies recovery by persisting`, async ({ page }) => {
		await setup(page, async (route) => {
			const body = route.request().postDataJSON() as SemanticRequestV3;
			const id = body.requestId;
			const delta = (seq: number, text: string, requestId = id) =>
				`event: analysis_delta\ndata: ${JSON.stringify({ requestId, seq, text })}\n\n`;
			const first = delta(0, '辨識中');
			const bad =
				fault === 'gap'
					? delta(2, '午餐')
					: fault === 'duplicate'
						? delta(0, '午餐')
						: fault === 'wrong-id'
							? delta(1, '午餐', row.id)
							: fault === 'oversize'
								? delta(1, '字'.repeat(201))
								: `event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId: id })}\n\n` +
									delta(1, '午餐');
			await route.fulfill({
				contentType: 'text/event-stream',
				body: first + bad + `event: result\ndata: ${JSON.stringify(created(id))}\n\n`
			});
		});
		await submit(page);
		await expect(
			page.getByText(fault === 'after-writing' ? '結果待確認' : '未新增', { exact: true })
		).toBeVisible();
		await expect(page.getByText('已新增', { exact: true })).toHaveCount(0);
		const stored = await page.evaluate(() => JSON.stringify(localStorage));
		expect(stored).not.toContain('辨識中');
	});
}

test('analysis is plain text and is cleared for the next operation', async ({ page }) => {
	await setup(page, async (route) => {
		const { requestId } = route.request().postDataJSON() as SemanticRequestV3;
		await route.fulfill({
			contentType: 'text/event-stream',
			body: `event: analysis_delta\ndata: ${JSON.stringify({ requestId, seq: 0, text: '<b>午餐</b>' })}\n\nevent: result\ndata: ${JSON.stringify(created(requestId))}\n\n`
		});
	});
	await submit(page);
	await expect(page.getByLabel('Gemini 分析摘要')).toHaveText('<b>午餐</b>');
	await expect(page.getByLabel('Gemini 分析摘要').locator('b')).toHaveCount(0);
	await page.getByRole('button', { name: '新增另一筆', exact: true }).click();
	await expect(page.getByLabel('Gemini 分析摘要')).toHaveCount(0);
});

test('chat preserves earlier messages and analysis without sending analysis in question history', async ({
	page
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	let round = 0;
	const s = await setup(page, async (route, body) => {
		if (++round === 1) {
			await route.fulfill({
				contentType: 'text/event-stream',
				body: `event: analysis_delta\ndata: ${JSON.stringify({ requestId: body!.requestId, seq: 0, text: '第一輪摘要' })}\n\nevent: result\ndata: ${JSON.stringify({ status: 'needs_input', requestId: body!.requestId, question: '這筆支出的台幣總金額是多少？', issues: [{ field: 'amount', code: 'missing' }] })}\n\n`
			});
		} else {
			await wait;
			await route.fulfill({
				contentType: 'text/event-stream',
				body: `event: result\ndata: ${JSON.stringify(created(body!.requestId))}\n\n`
			});
		}
	});
	try {
		await submit(page);
		const conversation = page.getByRole('region', { name: '本次對話' });
		await expect(conversation.getByLabel('你的訊息')).toHaveText(['午餐100']);
		await expect(page.getByLabel('Gemini 分析摘要')).toHaveText('第一輪摘要');
		await expect(page.getByText('這筆支出的台幣總金額是多少？', { exact: true })).toBeVisible();
		await page.getByLabel('補充資訊').fill('100');
		await page.getByRole('button', { name: '送出補充', exact: true }).click();
		await expect(page.getByLabel('Gemini 分析摘要')).toHaveCount(0);
		await expect(conversation.getByLabel('先前的分析摘要')).toHaveText('第一輪摘要');
		await expect(conversation.getByLabel('你的訊息')).toHaveText(['午餐100', '100']);
		await expect(
			conversation.getByText('這筆支出的台幣總金額是多少？', { exact: true })
		).toBeVisible();
		await expect.poll(() => s.posts.length).toBe(2);
		expect(s.posts[1].history).toEqual([
			{ question: '這筆支出的台幣總金額是多少？', answer: '100' }
		]);
		release();
		await expect(page.getByText('已新增', { exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('chat.png') });
		await page.getByRole('button', { name: '新增另一筆', exact: true }).click();
		await expect(conversation.getByLabel('你的訊息')).toHaveCount(0);
		await expect(conversation.getByLabel('先前的分析摘要')).toHaveCount(0);
	} finally {
		release();
	}
});

for (const action of ['account-switch', 'pagehide', 'status-query']) {
	test(`analysis clears on ${action}`, async ({ page }) => {
		const s = await setup(page, async (route, body) => {
			if (!body) {
				await route.fulfill({
					json: {
						status: 'not_found',
						requestId: route.request().url().split('/').at(-1)
					}
				});
				return;
			}
			await route.fulfill({
				contentType: 'text/event-stream',
				body:
					`event: analysis_delta\ndata: ${JSON.stringify({ requestId: body.requestId, seq: 0, text: '本帳號的暫時摘要' })}\n\n` +
					`event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId: body.requestId })}\n\n`
			});
		});
		await submit(page);
		await expect(page.getByLabel('Gemini 分析摘要')).toHaveText('本帳號的暫時摘要');
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		if (action === 'account-switch') {
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
		} else if (action === 'pagehide') {
			await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
		} else {
			await trayAction(page, '查詢結果');
		}
		await expect(page.getByLabel('Gemini 分析摘要')).toHaveCount(0);
	});
}

for (const suffix of ['analysis', 'second-result']) {
	test(`terminal result rejects trailing ${suffix}`, async ({ page }) => {
		await setup(page, async (route, body) => {
			const requestId = body!.requestId;
			const result = `event: result\ndata: ${JSON.stringify(created(requestId))}\n\n`;
			const trailing =
				suffix === 'analysis'
					? `event: analysis_delta\ndata: ${JSON.stringify({ requestId, seq: 0, text: '遲到的摘要' })}\n\n`
					: result;
			await route.fulfill({
				contentType: 'text/event-stream',
				body:
					`event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId })}\n\n` +
					result +
					trailing
			});
		});
		await submit(page);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await expect(page.getByText('已新增', { exact: true })).toHaveCount(0);
	});
}

test('chat composer stays visible and shows a hint for the current phase', async ({ page }) => {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	await setup(page, async (route, body) => {
		await wait;
		await route.fulfill({
			json: {
				status: 'needs_input',
				requestId: body!.requestId,
				question: '這筆支出的台幣總金額是多少？',
				issues: [{ field: 'amount', code: 'missing' }]
			}
		});
	});
	try {
		const composer = page.getByRole('dialog').locator('textarea');
		await expect(composer).toHaveCount(1);
		await expect(
			page.getByText('資訊完整後會直接記帳；多筆或不完整時會先列出草稿。', { exact: true })
		).toBeVisible();
		await submit(page);
		await expect(composer).toBeVisible();
		await expect(composer).toBeDisabled();
		await expect(page.getByText('正在解析，請等待助手回覆。', { exact: true })).toBeVisible();
		release();
		await expect(page.getByLabel('補充資訊')).toBeEditable();
		await expect(composer).toHaveCount(1);
		await expect(page.locator('#semantic-entry-hint')).toContainText('2026-10-01');
	} finally {
		release();
	}
});

test('AI dialog has one visible title and no mode switch', async ({ page }) => {
	await setup(page, async (route, body) => {
		await route.fulfill({ json: created(body!.requestId) });
	});
	await expect(page.getByRole('dialog')).toHaveAccessibleName('AI 記帳');
	await expect(page.getByRole('heading', { name: 'AI 記帳', exact: true })).toBeVisible();
	await expect(page.getByRole('group', { name: 'AI 記帳模式' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: '文字記帳', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: '圖片分析', exact: true })).toHaveCount(0);
	await expect(page.getByLabel('記帳內容')).toBeEditable();
});

test.describe('Taiwan conversation date baseline', () => {
	test.use({ timezoneId: 'America/Los_Angeles' });
	test('initial uncertain retry retains baseline across midnight and new operation gets new day', async ({
		page
	}) => {
		let count = 0;
		const s = await setup(page, async (route, body) => {
			if (++count === 1) {
				await interrupted(route, body!.requestId);
			} else {
				await route.fulfill({ json: created(body!.requestId) });
			}
		});
		await page.clock.setFixedTime(new Date('2026-10-01T23:59:00+08:00'));
		await submit(page);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await page.clock.setFixedTime(new Date('2026-10-02T00:01:00+08:00'));
		await trayAction(page, '重試同一請求');
		await expect(page.getByText('已新增', { exact: true })).toBeVisible();
		expect(s.posts[0].referenceDate).toBe('2026-10-01');
		expect(s.posts[1]).toEqual(s.posts[0]);
		await page.getByRole('button', { name: '新增另一筆' }).click();
		await page.getByLabel('記帳內容').fill('午餐100');
		await submit(page);
		await expect.poll(() => s.posts.length).toBe(3);
		expect(s.posts[2].referenceDate).toBe('2026-10-02');
		expect(s.posts[2].requestId).not.toBe(s.posts[0].requestId);
	});
	test('clarification retains Taiwan baseline across midnight', async ({ page }) => {
		const question = '這筆支出的金額是多少？';
		const s = await setup(page, async (route, body) => {
			await route.fulfill({
				json: body!.history
					? created(body!.requestId)
					: {
							status: 'needs_input',
							requestId: body!.requestId,
							question,
							issues: [{ field: 'amount', code: 'missing' }]
						}
			});
		});
		await page.clock.setFixedTime(new Date('2026-10-01T23:59:00+08:00'));
		await page.getByLabel('記帳內容').fill('今天午餐');
		await submit(page);
		await expect(page.getByText(question, { exact: true })).toBeVisible();
		await page.clock.setFixedTime(new Date('2026-10-02T00:01:00+08:00'));
		await expect(page.locator('#semantic-entry-hint')).toContainText('2026-10-01');
		await page.getByLabel('補充資訊').fill('100元');
		await page.getByRole('button', { name: '送出補充', exact: true }).click();
		await expect(page.getByText('已新增', { exact: true })).toBeVisible();
		expect(s.posts[0].referenceDate).toBe('2026-10-01');
		expect(s.posts[1]).toEqual({ ...s.posts[0], history: [{ question, answer: '100元' }] });
	});
});

const png = {
	name: 'synthetic.png',
	mimeType: 'image/png',
	buffer: Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',
		'base64'
	)
};
const imagePath = `uploads/${user.id}/synthetic.png`;
async function mockUploads(page: Page, errorCode?: string) {
	const calls: unknown[] = [];
	let puts = 0;
	await page.route(`${endpoint}/semantic-entry/uploads`, async (route) => {
		expect(route.request().headers().authorization).toBe('Bearer synthetic-jwt');
		expect(route.request().method()).toBe('POST');
		calls.push(route.request().postDataJSON());
		if (errorCode) {
			await route.fulfill({
				status: 400,
				json: { error: { code: errorCode, uncertain: false } }
			});
		} else {
			await route.fulfill({
				json: {
					uploads: [
						{
							path: imagePath,
							url: 'https://storage.example.test/synthetic.png',
							expiresAt: '2026-10-01T04:15:00Z',
							requiredHeaders: { 'Content-Type': 'image/png' }
						}
					]
				}
			});
		}
	});
	await page.route('https://storage.example.test/**', async (route) => {
		puts++;
		expect(route.request().method()).toBe('PUT');
		expect(route.request().headers().authorization).toBeUndefined();
		expect(route.request().headers()['content-type']).toBe('image/png');
		expect(route.request().postDataBuffer()).toEqual(png.buffer);
		await route.fulfill({ status: 200, body: '' });
	});
	return { calls, puts: () => puts };
}
const attach = (page: Page) => page.locator('input[type=file][multiple]').setInputFiles(png);
const pending = (page: Page) =>
	page.evaluate((id) => localStorage.getItem(`jopie:semantic-pending:${id}`), user.id);
const pendingItems = async (page: Page): Promise<pendingStore.PendingItem[]> =>
	JSON.parse((await pending(page)) ?? '{"items":[]}').items;

test('image and text upload once then create a summary and update home without client writes', async ({
	page
}, testInfo) => {
	const s = await setup(page, async (route, body) => {
		const requestId = body!.requestId;
		await route.fulfill({
			contentType: 'text/event-stream',
			body:
				`event: analysis_delta\ndata: ${JSON.stringify({ requestId, seq: 0, text: '合成收據分析' })}\n\n` +
				`event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId })}\n\n` +
				`event: result\ndata: ${JSON.stringify(created(requestId))}\n\n`
		});
	});
	const uploads = await mockUploads(page);
	await page.getByLabel('記帳內容').fill('昨天晚餐');
	await attach(page);
	await expect(page.getByRole('img', { name: '第 1 張附圖' })).toBeVisible();
	await submit(page);
	const summary = page.getByRole('group', { name: '已記帳摘要' });
	await expect(summary).toContainText('已記帳 1 筆');
	await expect(summary).toContainText('2026-10-01');
	await expect(summary.getByRole('button')).toHaveCount(0);
	await expect(page.getByRole('button', { name: '新增另一筆', exact: true })).toHaveCount(0);
	await expect(page.getByLabel('記帳內容')).toBeEditable();
	expect(uploads.calls).toEqual([
		{ files: [{ contentType: 'image/png', size: png.buffer.length }] }
	]);
	expect(uploads.puts()).toBe(1);
	expect(s.posts[0]).toEqual({
		action: 'analyze',
		requestId: s.posts[0].requestId,
		referenceDate: '2026-10-01',
		text: '昨天晚餐',
		images: [imagePath]
	});
	expect(await pending(page)).toBeNull();
	expect(s.writes()).toBe(0);
	await testInfo.attach('image-created-aria', {
		body: await page.getByRole('dialog').ariaSnapshot(),
		contentType: 'text/yaml'
	});
	await page.screenshot({ path: testInfo.outputPath('image-created.png') });
	// The next submit starts a fresh operation while retaining this summary.
	await page.getByLabel('記帳內容').fill('另一筆午餐100');
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts[1].requestId).not.toBe(s.posts[0].requestId);
	expect(s.posts[1].images).toBeUndefined();
	await expect(summary).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(
		page.locator('section[data-date="2026-10-01"]').getByText('語意午餐', { exact: true })
	).toBeVisible();
	expect(s.writes()).toBe(0);
});

test('client rejects image count, size and type without network calls', async ({ page }) => {
	const s = await setup(page, async (route) => route.abort());
	const uploads = await mockUploads(page);
	const input = page.locator('input[type=file][multiple]');
	await input.setInputFiles(
		Array.from({ length: 5 }, (_, i) => ({ ...png, name: `synthetic-${i}.png` }))
	);
	await expect(page.locator('#semantic-entry-hint')).toHaveText('最多附加 4 張圖片。');
	await input.setInputFiles({ ...png, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
	await expect(page.locator('#semantic-entry-hint')).toHaveText('單張圖片不能超過 10 MiB。');
	await input.setInputFiles({
		name: 'synthetic.gif',
		mimeType: 'image/gif',
		buffer: Buffer.from('GIF89a')
	});
	await expect(page.locator('#semantic-entry-hint')).toHaveText(
		'只支援 JPG、PNG、WebP、HEIC 圖片。'
	);
	expect(uploads.calls).toHaveLength(0);
	expect(uploads.puts()).toBe(0);
	expect(s.posts).toHaveLength(0);
	await expect(page.getByRole('button', { name: '移除第 1 張圖片' })).toHaveCount(0);
	await attach(page);
	await expect(page.locator('#semantic-entry-hint')).toHaveText(
		'資訊完整後會直接記帳；多筆或不完整時會先列出草稿。'
	);
});

for (const [code, message] of [
	['quota_exceeded', '今天的解析次數已用完。'],
	['image_limit', '圖片上傳失敗，請稍後再試。']
]) {
	test(`upload endpoint ${code} clears pending without analyzing`, async ({ page }) => {
		const s = await setup(page, async (route) => route.abort());
		const uploads = await mockUploads(page, code);
		await attach(page);
		await submit(page);
		await expect(page.getByText('未新增', { exact: true })).toBeVisible();
		await expect(page.getByText(message, { exact: true })).toBeVisible();
		expect(await pending(page)).toBeNull();
		expect(uploads.calls).toHaveLength(1);
		expect(uploads.puts()).toBe(0);
		expect(s.posts).toHaveLength(0);
		expect(s.writes()).toBe(0);
	});
}

test('uncertain image analyze retries the identical payload without uploading again', async ({
	page
}) => {
	let count = 0;
	const s = await setup(page, async (route, body) => {
		if (++count === 1) {
			await interrupted(route, body!.requestId);
		} else {
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	const uploads = await mockUploads(page);
	await attach(page);
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '附加圖片', exact: true })).toBeEnabled();
	await trayAction(page, '重試同一請求');
	await expect(page.getByRole('group', { name: '已記帳摘要' })).toContainText('已記帳 1 筆');
	expect(s.posts[1]).toEqual(s.posts[0]);
	expect(s.posts[1].images).toEqual([imagePath]);
	expect(uploads.calls).toHaveLength(1);
	expect(uploads.puts()).toBe(1);
	expect(await pending(page)).toBeNull();
});

test('non receipt rejection displays image guidance and performs zero writes', async ({ page }) => {
	const s = await setup(page, async (route, body) => {
		await route.fulfill({
			status: 422,
			json: {
				status: 'rejected',
				requestId: body!.requestId,
				issues: [{ field: 'images', code: 'not_a_receipt' }]
			}
		});
	});
	await mockUploads(page);
	await attach(page);
	await submit(page);
	await expect(
		page.getByText('圖片看起來不是收據，請重新選擇圖片。', { exact: true })
	).toBeVisible();
	expect(s.writes()).toBe(0);
	expect(await pending(page)).toBeNull();
});

test('removing the last thumbnail disables an empty composer', async ({ page }) => {
	await setup(page, async (route) => route.abort());
	await page.getByLabel('記帳內容').fill('');
	await attach(page);
	await expect(page.getByRole('button', { name: '送出記帳', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: '移除第 1 張圖片' }).click();
	await expect(page.getByRole('img', { name: '第 1 張附圖' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: '送出記帳', exact: true })).toBeDisabled();
});

const categoryId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function makeDraft(index: number): Draft {
	const field = <T>(value: T) => ({
		value,
		state: 'recognized' as const,
		confidence: 0.95,
		source: 'image' as const
	});
	return {
		draftId: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`,
		note: field(`合成帳目${index}`),
		amount: field(index * 100),
		currency: field('TWD'),
		date: { ...field('2026-10-01'), defaulted: null },
		categoryId: field(categoryId),
		scope: field('personal'),
		payerEmail: field(user.email),
		splitMemberEmails: field([user.email]),
		status: 'complete',
		issues: []
	};
}
const draftResponse = (requestId: string, drafts: Draft[], reason = 'multiple') => ({
	status: 'drafts',
	requestId,
	drafts,
	reason,
	metadata: created(requestId).metadata
});
const draftBlock = (page: Page) => page.getByRole('group', { name: '草稿', exact: true });
const commitDrafts = (page: Page, count = 3) =>
	page.getByRole('button', { name: `全部記帳（${count} 筆）`, exact: true });
async function startDrafts(page: Page) {
	await mockUploads(page);
	await attach(page);
	await submit(page);
	await expect(draftBlock(page)).toBeVisible();
	expect(await pending(page)).toBeNull();
}

test('image drafts show incomplete issues, foreign currency and disabled commit', async ({
	page
}, testInfo) => {
	const drafts = [1, 2, 3, 4].map(makeDraft);
	drafts[2].amount = { value: null, state: 'unrecognized', confidence: null, source: 'image' };
	drafts[2].categoryId = { value: null, state: 'missing', confidence: null, source: 'image' };
	drafts[2].issues = [
		{ field: 'amount', code: 'unrecognized' },
		{ field: 'categoryId', code: 'missing' }
	];
	drafts[2].status = 'incomplete';
	drafts[3].currency.value = 'JPY';
	drafts[3].originalAmount = { text: 'JPY 400', currency: 'JPY' };
	drafts[3].issues = [{ field: 'currency', code: 'non_twd' }];
	drafts[3].status = 'incomplete';
	const s = await setup(page, async (route, body) =>
		route.fulfill({ json: draftResponse(body!.requestId, drafts) })
	);
	await startDrafts(page);
	await expect(draftBlock(page)).toContainText('草稿 4 筆（尚未記帳）');
	await expect(draftBlock(page)).toContainText('完整 2／4');
	await expect(draftBlock(page)).toContainText('金額無法辨識、分類未選');
	await expect(draftBlock(page)).toContainText('需換算成 TWD');
	await expect(draftBlock(page)).toContainText('第 3、4 筆需要補齊。');
	await expect(commitDrafts(page, 4)).toBeDisabled();
	await expect(page.getByLabel('補充草稿')).toBeEditable();
	await expect(page.getByRole('button', { name: '附加圖片', exact: true })).toBeDisabled();
	await expect(page.locator('#semantic-entry-hint')).toHaveText(
		'可以直接打字補充，例如「第三筆是午餐」。'
	);
	await page.getByLabel('補充草稿').fill('第三筆是午餐');
	await expect(page.locator('#semantic-entry-hint')).toHaveText(
		'補充只更新草稿，不會重新讀取圖片。'
	);
	await testInfo.attach('drafts-aria', {
		body: await page.getByRole('dialog').ariaSnapshot(),
		contentType: 'text/yaml'
	});
	await page.screenshot({ path: testInfo.outputPath('drafts.png') });
	expect(s.writes()).toBe(0);
});

test('automatic grouping renders the merged amount in one row', async ({ page }) => {
	const drafts = [makeDraft(1), makeDraft(2)];
	drafts[1].note.value = drafts[0].note.value;
	const s = await setup(page, async (route, body) =>
		route.fulfill({ json: draftResponse(body!.requestId, drafts) })
	);
	await startDrafts(page);
	await expect(draftBlock(page).getByRole('listitem')).toHaveCount(1);
	await expect(draftBlock(page)).toContainText('合成帳目1 等 2 項');
	await expect(draftBlock(page)).toContainText('NT$ 300');
	await expect(draftBlock(page)).toContainText('已合併');
	await expect(commitDrafts(page, 1)).toBeEnabled();
	expect(s.writes()).toBe(0);
});

test('revise updates the same block and appends the conversation without images or history', async ({
	page
}) => {
	const drafts = [1, 2, 3].map(makeDraft);
	const s = await setup(page, async (route, body) => {
		if (body!.action === 'revise') {
			drafts[2] = { ...drafts[2], note: { ...drafts[2].note, value: '午餐' }, updated: true };
		}
		await route.fulfill({ json: draftResponse(body!.requestId, drafts) });
	});
	await startDrafts(page);
	const block = draftBlock(page);
	await block.evaluate((element) => element.setAttribute('data-original-block', 'yes'));
	await page.getByLabel('補充草稿').fill('第三筆是午餐');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(block).toContainText('剛更新');
	await expect(block).toContainText('午餐');
	await expect(block).toHaveCount(1);
	await expect(block).toHaveAttribute('data-original-block', 'yes');
	await expect(page.getByLabel('你的訊息').last()).toHaveText('第三筆是午餐');
	await expect(page.getByText('已更新草稿。', { exact: true })).toBeVisible();
	const revision = s.posts[1];
	expect(revision).toMatchObject({
		action: 'revise',
		text: '第三筆是午餐',
		referenceDate: '2026-10-01'
	});
	expect(revision.drafts).toHaveLength(3);
	expect(revision.requestId).not.toBe(s.posts[0].requestId);
	expect(revision.images).toBeUndefined();
	expect(revision.history).toBeUndefined();
	expect(await pending(page)).toBeNull();
	expect(s.writes()).toBe(0);
});

async function shortenTimeout(page: Page) {
	await page.evaluate((timeout) => {
		const original = AbortSignal.timeout;
		AbortSignal.timeout = (ms) => original(ms === timeout ? 50 : ms);
	}, SEMANTIC_TIMEOUT_MS);
}

test('revise timeout preserves drafts and clears pending without uncertainty', async ({ page }) => {
	const s = await setup(page, async (route, body) => {
		if (body!.action === 'revise') {
			return;
		}
		await route.fulfill({ json: draftResponse(body!.requestId, [1, 2, 3].map(makeDraft)) });
	});
	await startDrafts(page);
	await shortenTimeout(page);
	await page.getByLabel('補充草稿').fill('第三筆是午餐');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(page.getByText(/沒有更新草稿：/)).toBeVisible();
	await expect(draftBlock(page).getByRole('listitem')).toHaveCount(3);
	await expect(page.getByLabel('補充草稿')).toBeEditable();
	await expect(page.getByText('結果待確認', { exact: true })).toHaveCount(0);
	expect(await pending(page)).toBeNull();
	expect(s.writes()).toBe(0);
});

const batchRows = [1, 2, 3].map((index) => ({
	...row,
	id: `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, '0')}`,
	note: `合成帳目${index}`,
	amount: index * 100,
	shares_json: { [user.email]: index * 100 }
}));

test('commit creates all rows with ClientDraft payload and removes draft controls', async ({
	page
}, testInfo) => {
	const s = await setup(page, async (route, body) => {
		if (body!.action === 'analyze') {
			return void (await route.fulfill({
				json: draftResponse(body!.requestId, [1, 2, 3].map(makeDraft))
			}));
		}
		await route.fulfill({
			contentType: 'text/event-stream',
			body: `event: persisting\ndata: ${JSON.stringify({ status: 'persisting', requestId: body!.requestId })}\n\nevent: result\ndata: ${JSON.stringify({ ...created(body!.requestId), expenses: batchRows })}\n\n`
		});
	});
	await startDrafts(page);
	await expect(page.locator('#semantic-entry-hint')).toHaveText(
		'可以繼續補充，或按「全部記帳」。'
	);
	await commitDrafts(page).click();
	const summary = page.getByRole('group', { name: '已記帳摘要' });
	await expect(summary).toContainText('已記帳 3 筆，合計 NT$ 600');
	await expect(summary.getByRole('button')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /全部記帳|進入編輯|新增另一筆/ })).toHaveCount(0);
	await expect(draftBlock(page)).toHaveCount(0);
	await expect(page.getByLabel('記帳內容')).toBeEditable();
	const body = s.posts[1];
	expect(body.action).toBe('commit');
	expect(body.requestId).not.toBe(s.posts[0].requestId);
	expect(Object.keys(body).sort()).toEqual(['action', 'drafts', 'referenceDate', 'requestId']);
	for (const draft of body.drafts!) {
		expect(draft).not.toHaveProperty('status');
		expect(draft).not.toHaveProperty('issues');
		expect(draft).not.toHaveProperty('updated');
	}
	expect(await pending(page)).toBeNull();
	await testInfo.attach('commit-aria', {
		body: await page.getByRole('dialog').ariaSnapshot(),
		contentType: 'text/yaml'
	});
	await page.screenshot({ path: testInfo.outputPath('commit.png') });
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	for (const row of batchRows) {
		await expect(
			page.locator('section[data-date="2026-10-01"]').getByText(row.note, { exact: true })
		).toBeVisible();
	}
	expect(s.writes()).toBe(0);
});

test('commit rejects the whole batch and marks the matching server draft issue', async ({
	page
}) => {
	const drafts = [1, 2, 3].map(makeDraft);
	const s = await setup(page, async (route, body) => {
		await route.fulfill(
			body!.action === 'analyze'
				? { json: draftResponse(body!.requestId, drafts) }
				: {
						status: 422,
						json: {
							status: 'rejected',
							requestId: body!.requestId,
							issues: [{ field: 'categoryId', code: 'invalid' }],
							draftIssues: [
								{
									draftId: drafts[1].draftId,
									issues: [{ field: 'categoryId', code: 'invalid' }]
								}
							]
						}
					}
		);
	});
	await startDrafts(page);
	await commitDrafts(page).click();
	await expect(page.getByText('未記帳：3 筆都沒有寫入', { exact: true })).toBeVisible();
	await expect(
		page.getByText('伺服器檢查時發現 1 筆有問題，草稿都還在。', { exact: true })
	).toBeVisible();
	await expect(draftBlock(page).getByRole('listitem').nth(1)).toContainText(
		'分類已不存在，請重新選擇'
	);
	await expect(commitDrafts(page)).toBeDisabled();
	await expect(draftBlock(page)).toContainText('完整 2／3');
	expect(await pending(page)).toBeNull();
	expect(s.writes()).toBe(0);
});

for (const action of ['retry', 'close'] as const) {
	test(`commit interrupted after persisting ${action} preserves recovery and never writes expenses directly`, async ({
		page
	}) => {
		let commits = 0;
		let expenseReads = 0;
		page.on('request', (request) => {
			if (
				request.method() === 'GET' &&
				new URL(request.url()).pathname.endsWith('/rest/v1/expenses')
			) {
				expenseReads++;
			}
		});
		const s = await setup(page, async (route, body) => {
			if (!body) {
				await route.fulfill({
					json: {
						status: 'completed',
						requestId: route.request().url().split('/').at(-1),
						expenses: batchRows,
						replayed: true
					}
				});
			} else if (body.action === 'analyze') {
				await route.fulfill({
					json: draftResponse(body.requestId, [1, 2, 3].map(makeDraft))
				});
			} else if (++commits > 1) {
				await route.fulfill({
					json: { ...created(body.requestId, true), expenses: batchRows }
				});
			} else {
				await interrupted(route, body.requestId);
			}
		});
		await startDrafts(page);
		await commitDrafts(page).click();
		// Q8: the drafts block is removed and the tray opens with the commit item expanded.
		await expect(pendingTray(page)).toBeVisible();
		await expect(trayRows(page)).toHaveCount(1);
		await expect(trayRows(page).first()).toContainText('（草稿，未存內容）');
		await expect(trayRows(page).first()).toContainText('確認 3 筆草稿');
		await expect(trayRows(page).first().locator('button[aria-expanded]')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await expect(draftBlock(page)).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^全部記帳/ })).toHaveCount(0);
		await expect(page.getByText('結果待確認', { exact: true })).toHaveCount(0);
		await expect(page.getByLabel('記帳內容')).toBeEditable();
		expect((await pendingItems(page))[0].requestId).toBe(s.posts[1].requestId);
		s.setRows(batchRows);
		const before = expenseReads;
		if (action === 'retry') {
			await trayAction(page, '重試同一請求');
			await expect(createdSummary(page)).toContainText('已記帳 3 筆');
			expect(s.posts[2]).toEqual(s.posts[1]);
			expect(expenseReads).toBeGreaterThan(before);
			expect(await pending(page)).toBeNull();
		} else {
			await page.keyboard.press('Escape');
			await expect(pendingTray(page)).toHaveCount(0);
			await page
				.getByRole('dialog')
				.getByRole('button', { name: 'Close', exact: true })
				.click();
			await expect(page.getByRole('dialog')).toHaveCount(0);
			expect((await pendingItems(page))[0].requestId).toBe(s.posts[1].requestId);
			await page
				.locator('section[data-date="2026-10-01"]')
				.getByRole('button', { name: 'AI 記帳', exact: true })
				.click();
			await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
			await expect(draftBlock(page)).toHaveCount(0);
			await trayAction(page, '重試同一請求');
			await expect(page.getByRole('group', { name: '已記帳摘要' })).toContainText(
				'已記帳 3 筆'
			);
			expect(s.posts[2]).toEqual(s.posts[1]);
			expect(expenseReads).toBeGreaterThan(before);
			expect(await pending(page)).toBeNull();
		}
		expect(s.writes()).toBe(0);
	});
}

test('commit retry after close that replays a rejection clears the pending item', async ({
	page
}) => {
	let commits = 0;
	const s = await setup(page, async (route, body) => {
		if (body?.action === 'analyze') {
			await route.fulfill({
				json: draftResponse(body.requestId, [1, 2, 3].map(makeDraft))
			});
		} else if (body && ++commits > 1) {
			await route.fulfill({
				status: 422,
				json: {
					status: 'rejected',
					requestId: body.requestId,
					issues: [{ field: 'categoryId', code: 'invalid' }]
				}
			});
		} else if (body) {
			await interrupted(route, body.requestId);
		}
	});
	await startDrafts(page);
	await commitDrafts(page).click();
	await expect(pendingTray(page)).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(pendingTray(page)).toHaveCount(0);
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page
		.locator('section[data-date="2026-10-01"]')
		.getByRole('button', { name: 'AI 記帳', exact: true })
		.click();
	await trayAction(page, '重試同一請求');
	await expect(page.getByText('未記帳：3 筆都沒有寫入', { exact: true })).toBeVisible();
	expect(s.posts[2]).toEqual(s.posts[1]);
	await expect(page.getByText('結果待確認', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('dialog').locator('textarea')).toBeEditable();
	await expect(pendingBadge(page)).toHaveCount(0);
	expect(await pending(page)).toBeNull();
	expect(s.writes()).toBe(0);
});

test('draft model preserves server issues and merges visible members in their original order', () => {
	const first = makeDraft(1);
	const second = makeDraft(2);
	second.note.value = first.note.value;
	const middle = makeDraft(3);
	const session = fromServerDrafts([first, middle, second]);
	expect(session.items.map((item) => [item.hidden, item.edited])).toEqual([
		[false, false],
		[false, false],
		[false, false]
	]);
	const merged = effectiveDrafts(session);
	expect(merged.map((draft) => draft.draftId)).toEqual([first.draftId, middle.draftId]);
	expect(merged[0].mergedFrom).toEqual([first.draftId, second.draftId]);
	expect(merged[0].amount).toEqual({
		value: 300,
		state: 'recognized',
		confidence: null,
		source: 'user'
	});
	expect(first.amount.value).toBe(100);
	session.items[0].hidden = true;
	expect(effectiveDrafts(session)).toEqual([middle, second]);
	session.items[0].hidden = false;
	session.groupSummaries[session.items[0].groupId!] = {
		...merged[0],
		note: { ...first.note, value: '使用者摘要' }
	};
	expect(effectiveDrafts(session)[0].note.value).toBe('使用者摘要');
	const incomplete = makeDraft(4);
	incomplete.note.value = null;
	incomplete.issues = [{ field: 'note', code: 'unrecognized' }];
	const ungrouped = fromServerDrafts([incomplete, { ...incomplete, draftId: second.draftId }]);
	expect(ungrouped.items.every((item) => item.groupId === undefined)).toBe(true);
	expect(isComplete(effectiveDrafts(ungrouped)[0])).toBe(false);
	expect(toClientDraft(incomplete)).not.toHaveProperty('issues');
});

test('draft model recalculates merged and edited issues with one priority per field', () => {
	const ctx = {
		today: '2026-10-01',
		categoryIds: new Set([categoryId]),
		allowedEmails: [user.email, 'b@example.test'],
		currentUserEmail: user.email
	};
	const first = makeDraft(1);
	const second = makeDraft(2);
	second.note.value = first.note.value;
	second.amount.value = null;
	const session = fromServerDrafts([first, second]);
	const merged = effectiveDrafts(session, ctx)[0];
	expect(merged.amount.value).toBeNull();
	expect(merged.amount.state).toBe('missing');
	expect(merged.issues).toEqual([{ field: 'amount', code: 'missing' }]);
	const invalid = makeDraft(3);
	invalid.amount = { value: null, state: 'unrecognized', confidence: null, source: 'image' };
	invalid.currency.value = 'JPY';
	invalid.currency.confidence = 0.2;
	invalid.categoryId.value = 'deleted';
	invalid.categoryId.confidence = 0.2;
	invalid.date.value = '2026-10-02';
	invalid.date.defaulted = 'unreadable';
	invalid.date.confidence = 0.2;
	invalid.scope.value = 'household';
	invalid.splitMemberEmails.value = ['b@example.test', 'b@example.test'];
	invalid.payerEmail.value = 'unknown@example.test';
	expect(draftIssues(invalid, ctx)).toEqual(
		expect.arrayContaining([
			{ field: 'amount', code: 'unrecognized' },
			{ field: 'currency', code: 'non_twd' },
			{ field: 'categoryId', code: 'invalid' },
			{ field: 'date', code: 'future_date' },
			{ field: 'splitMemberEmails', code: 'unknown_member' },
			{ field: 'payerEmail', code: 'unknown_member' }
		])
	);
	const issues = draftIssues(invalid, ctx);
	expect(new Set(issues.map((issue) => issue.field)).size).toBe(issues.length);
	invalid.date.value = '2026-10-01';
	invalid.date.source = 'user';
	invalid.date.confidence = null;
	expect(draftIssues(invalid, ctx).some((issue) => issue.field === 'date')).toBe(false);
	const edited = fromServerDrafts([makeDraft(4)]);
	edited.items[0].edited = true;
	edited.items[0].draft.categoryId.value = 'deleted';
	expect(effectiveDrafts(edited, ctx)[0].issues).toContainEqual({
		field: 'categoryId',
		code: 'invalid'
	});
});

const editDialog = (page: Page) => page.getByRole('dialog', { name: '編輯草稿', exact: true });
const draftCards = (page: Page) => editDialog(page).locator('[data-draft-card="item"]');
async function openDraftEditor(page: Page) {
	await page.getByRole('button', { name: '進入編輯', exact: true }).click();
	await expect(editDialog(page)).toBeVisible();
}
async function editableDrafts(page: Page, drafts: Draft[]) {
	const state = await setup(page, async (route, body) => {
		await route.fulfill({
			json:
				body?.action === 'commit'
					? created(body.requestId)
					: draftResponse(body!.requestId, drafts)
		});
	});
	await startDrafts(page);
	await openDraftEditor(page);
	return state;
}

test('s4 incomplete draft editor keeps completion enabled and edits survive Escape', async ({
	page
}, testInfo) => {
	const drafts = [1, 2, 3, 4].map(makeDraft);
	drafts[2].amount = { value: null, state: 'missing', confidence: null, source: 'text' };
	drafts[2].issues = [{ field: 'amount', code: 'missing' }];
	drafts[2].status = 'incomplete';
	await editableDrafts(page, drafts);
	await expect(
		editDialog(page).getByRole('heading', { name: '編輯草稿', exact: true })
	).toBeVisible();
	await expect(editDialog(page)).toContainText('整理項目並送出：');
	await expect(draftCards(page)).toHaveCount(4);
	await expect(editDialog(page)).toContainText('請先補齊所有預覽項目的必要欄位。');
	await expect(
		editDialog(page).getByRole('button', { name: '完成，回到對話', exact: true })
	).toBeEnabled();
	await testInfo.attach('s4-aria', {
		body: await editDialog(page).ariaSnapshot(),
		contentType: 'text/yaml'
	});
	await page.screenshot({ path: testInfo.outputPath('s4.png') });
	await draftCards(page).nth(0).getByRole('button', { name: '排除', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(editDialog(page)).toHaveCount(0);
	await expect(page.getByText('已套用你的編輯。', { exact: true })).toBeVisible();
	await expect(draftBlock(page).getByRole('listitem')).toHaveCount(3);
	await openDraftEditor(page);
	await expect(
		draftCards(page).nth(0).getByRole('button', { name: '恢復', exact: true })
	).toBeVisible();
	await draftCards(page).nth(0).getByRole('button', { name: '恢復', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(draftBlock(page).getByRole('listitem')).toHaveCount(4);
});

test('manual merge and exclusion commit only effective drafts with merged provenance', async ({
	page
}, testInfo) => {
	const state = await editableDrafts(page, [1, 2, 3, 4].map(makeDraft));
	// Clicking a card outside selection does not open a panel.
	await draftCards(page).nth(0).getByText('合成帳目1', { exact: true }).click();
	await expect(page.getByRole('heading', { name: '編輯草稿 1/4' })).toHaveCount(0);
	await editDialog(page).getByRole('button', { name: '合併', exact: true }).click();
	await expect(
		editDialog(page).getByRole('button', { name: '完成，回到對話', exact: true })
	).toBeDisabled();
	await draftCards(page).nth(0).getByText('合成帳目1', { exact: true }).click();
	await editDialog(page).getByRole('checkbox', { name: '選取第 2 筆', exact: true }).check();
	await editDialog(page).getByRole('button', { name: '合併所選 (2)', exact: true }).click();
	await expect(editDialog(page).locator('[data-draft-card="summary"]')).toContainText('NT$ 300');
	await draftCards(page).nth(2).getByRole('button', { name: '排除', exact: true }).click();
	await testInfo.attach('s5a-aria', {
		body: await editDialog(page).ariaSnapshot(),
		contentType: 'text/yaml'
	});
	await page.screenshot({ path: testInfo.outputPath('s5a.png') });
	await editDialog(page)
		.getByRole('button', { name: '完成，回到對話（2 筆）', exact: true })
		.click();
	await expect(page.getByText('已套用你的編輯。', { exact: true })).toBeVisible();
	await expect(draftBlock(page)).toContainText('合成帳目1 等 2 項');
	await commitDrafts(page, 2).click();
	await expect.poll(() => state.posts.filter((post) => post.action === 'commit').length).toBe(1);
	const commit = state.posts.find((post) => post.action === 'commit')!;
	expect(commit.drafts).toHaveLength(2);
	expect(commit.drafts![0].amount.value).toBe(300);
	expect(commit.drafts![0].mergedFrom).toEqual([makeDraft(1).draftId, makeDraft(2).draftId]);
	expect(commit.drafts![1].draftId).toBe(makeDraft(4).draftId);
	expect(commit.drafts!.some((draft) => draft.draftId === makeDraft(3).draftId)).toBe(false);
});

// The dialog's outside-click listener attaches shortly after it opens; a click that lands
// earlier is ignored (harmless), so retry until the confirmation appears.
async function outsideClickUntilConfirm(page: Page, confirmation: Locator) {
	await expect(async () => {
		if (!(await confirmation.isVisible())) {
			await page.mouse.click(5, 5);
		}
		await expect(confirmation).toBeVisible({ timeout: 1000 });
	}).toPass();
}

test('automatic merge can be removed and all closure paths preserve changes', async ({ page }) => {
	const drafts = [makeDraft(1), makeDraft(2)];
	drafts[1].note.value = drafts[0].note.value;
	await editableDrafts(page, drafts);
	await expect(editDialog(page).locator('[data-draft-card="summary"]')).toContainText('NT$ 300');
	await editDialog(page).getByRole('button', { name: '解除合併', exact: true }).click();
	await expect(editDialog(page).locator('[data-draft-card="summary"]')).toHaveCount(0);
	await expect(draftCards(page)).toHaveCount(2);
	await editDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
	await expect(draftBlock(page).getByRole('listitem')).toHaveCount(2);
	await expect(page.getByText('已套用你的編輯。', { exact: true })).toHaveCount(1);
	await openDraftEditor(page);
	// No changes this time: closing must not append a second edit acknowledgement.
	const confirmation = page.getByRole('alertdialog', { name: '要關閉編輯草稿嗎？', exact: true });
	const aiDialog = page.getByRole('dialog', { name: 'AI 記帳', exact: true });
	await outsideClickUntilConfirm(page, confirmation);
	await expect(editDialog(page)).toBeVisible();
	await expect(aiDialog).toBeVisible();
	await confirmation.getByRole('button', { name: '繼續編輯', exact: true }).click();
	await expect(confirmation).toHaveCount(0);
	await expect(editDialog(page)).toBeVisible();
	await expect(draftCards(page)).toHaveCount(2);
	await outsideClickUntilConfirm(page, confirmation);
	await confirmation.getByRole('button', { name: '關閉', exact: true }).click();
	await expect(editDialog(page)).toHaveCount(0);
	await expect(aiDialog).toBeVisible();
	await expect(page.getByText('已套用你的編輯。', { exact: true })).toHaveCount(1);
	await expect(page.getByLabel('補充草稿')).toBeEditable();
});

test('outside close confirmation preserves draft changes without closing AI entry or writing expenses', async ({
	page
}) => {
	const state = await editableDrafts(page, [makeDraft(1), makeDraft(2)]);
	await draftCards(page).nth(0).getByRole('button', { name: '排除', exact: true }).click();
	const confirmation = page.getByRole('alertdialog', { name: '要關閉編輯草稿嗎？', exact: true });
	await outsideClickUntilConfirm(page, confirmation);
	await confirmation.getByRole('button', { name: '關閉', exact: true }).click();
	await expect(editDialog(page)).toHaveCount(0);
	await expect(page.getByRole('dialog', { name: 'AI 記帳', exact: true })).toBeVisible();
	await expect(draftBlock(page).getByRole('listitem')).toHaveCount(1);
	await expect(draftBlock(page)).toContainText('合成帳目2');
	await expect(draftBlock(page)).not.toContainText('合成帳目1');
	await expect(page.getByText('已套用你的編輯。', { exact: true })).toHaveCount(1);
	expect(state.writes()).toBe(0);
});

test('JPY panel validates an empty TWD amount, preserves unchanged fields and commits user conversion', async ({
	page
}, testInfo) => {
	const draft = makeDraft(1);
	draft.currency.value = 'JPY';
	draft.amount.value = 1300;
	draft.originalAmount = { text: '1300', currency: 'JPY' };
	draft.status = 'incomplete';
	draft.issues = [{ field: 'currency', code: 'non_twd' }];
	const state = await editableDrafts(page, [draft, makeDraft(2)]);
	await editDialog(page).getByRole('button', { name: '編輯第 1 筆', exact: true }).click();
	const panel = page.getByRole('dialog', { name: '編輯草稿 1/2', exact: true });
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('金額（TWD）');
	await expect(panel).toContainText('原幣 JPY 1300');
	await expect(panel.locator('#amount-input')).toHaveValue('');
	await expect(panel.getByText('建議', { exact: true })).toBeVisible();
	await panel.getByRole('button', { name: '套用到草稿', exact: true }).click();
	await expect(panel.getByRole('alert')).toHaveText('請輸入有效金額');
	await expect(panel).toBeVisible();
	await panel.locator('#amount-input').fill('260');
	await testInfo.attach('s6-aria', {
		body: await panel.ariaSnapshot(),
		contentType: 'text/yaml'
	});
	await page.screenshot({ path: testInfo.outputPath('s6.png') });
	await panel.getByRole('button', { name: '套用到草稿', exact: true }).click();
	await expect(panel).toHaveCount(0);
	await expect(draftCards(page).nth(0)).toContainText('NT$ 260');
	await expect(draftCards(page).nth(0)).not.toContainText('非 TWD');
	await editDialog(page).getByRole('button', { name: '完成，回到對話', exact: true }).click();
	await commitDrafts(page, 2).click();
	await expect.poll(() => state.posts.filter((post) => post.action === 'commit').length).toBe(1);
	const committed = state.posts.find((post) => post.action === 'commit')!.drafts![0];
	expect(committed.currency).toEqual({
		value: 'TWD',
		state: 'recognized',
		source: 'user',
		confidence: null
	});
	expect(committed.amount).toEqual({
		value: 260,
		state: 'recognized',
		source: 'user',
		confidence: null
	});
	for (const key of [
		'note',
		'date',
		'categoryId',
		'scope',
		'payerEmail',
		'splitMemberEmails',
		'originalAmount'
	] as const) {
		expect(committed[key]).toEqual(draft[key]);
	}
});

test('household draft shares are readonly and distribute remainder in email code unit order', async ({
	page
}) => {
	const draft = makeDraft(1);
	draft.scope.value = 'household';
	draft.splitMemberEmails.value = [
		'c@example.test',
		user.email,
		'b@example.test',
		'b@example.test'
	];
	const state = await setup(
		page,
		async (route, body) =>
			route.fulfill({
				json:
					body?.action === 'commit'
						? created(body.requestId)
						: draftResponse(body!.requestId, [draft])
			}),
		[],
		['c@example.test', 'b@example.test', user.email]
	);
	await startDrafts(page);
	await openDraftEditor(page);
	await editDialog(page).getByRole('button', { name: '編輯第 1 筆', exact: true }).click();
	const panel = page.getByRole('dialog', { name: '編輯草稿 1/1', exact: true });
	const shares = panel.getByRole('group', { name: '草稿分帳', exact: true });
	await expect(shares.locator('[data-member-email="a@example.test"]')).toHaveText(/34$/);
	await expect(shares.locator('[data-member-email="b@example.test"]')).toHaveText(/33$/);
	await expect(shares.locator('[data-member-email="c@example.test"]')).toHaveText(/33$/);
	await expect(shares.locator('input')).toHaveCount(0);
	await expect(panel.getByRole('button', { name: '平分', exact: true })).toHaveCount(0);
	await expect(panel.getByLabel('已結清', { exact: true })).toHaveCount(0);
	await panel.locator('#amount-input').fill('101');
	await expect(shares.locator('[data-member-email="b@example.test"]')).toHaveText(/34$/);
	await panel.getByRole('button', { name: '套用到草稿', exact: true }).click();
	await editDialog(page).getByRole('button', { name: '完成，回到對話', exact: true }).click();
	await commitDrafts(page, 1).click();
	await expect.poll(() => state.posts.filter((post) => post.action === 'commit').length).toBe(1);
	expect(
		state.posts.find((post) => post.action === 'commit')!.drafts![0].splitMemberEmails.value
	).toEqual(['c@example.test', user.email, 'b@example.test']);
});

test('Taipei date edit commits the exact calendar day and excluded editors omit position', async ({
	page
}) => {
	const draft = makeDraft(1);
	draft.date = { ...draft.date, source: 'default', defaulted: 'unreadable' };
	draft.issues = [{ field: 'date', code: 'date_defaulted' }];
	draft.status = 'incomplete';
	const state = await editableDrafts(page, [draft, makeDraft(2)]);
	await draftCards(page).nth(1).getByRole('button', { name: '排除', exact: true }).click();
	await editDialog(page).getByRole('button', { name: '編輯第 2 筆', exact: true }).click();
	await expect(page.getByRole('heading', { name: /^編輯草稿 \d/ })).toHaveCount(0);
	await page
		.getByRole('dialog', { name: '編輯草稿', exact: true })
		.last()
		.getByRole('button', { name: 'Close', exact: true })
		.click();
	await editDialog(page).getByRole('button', { name: '編輯第 1 筆', exact: true }).click();
	const panel = page.getByRole('dialog', { name: '編輯草稿 1/1', exact: true });
	await expect(panel.locator('#date-input')).toBeEnabled();
	await expect(panel.locator('#date-input')).toHaveAttribute('max', '2026-10-01');
	await panel.locator('#date-input').fill('2026-09-29');
	await panel.getByRole('button', { name: '套用到草稿', exact: true }).click();
	await editDialog(page)
		.getByRole('button', { name: '完成，回到對話（1 筆）', exact: true })
		.click();
	await commitDrafts(page, 1).click();
	await expect.poll(() => state.posts.filter((post) => post.action === 'commit').length).toBe(1);
	expect(state.posts.find((post) => post.action === 'commit')!.drafts![0].date).toEqual({
		value: '2026-09-29',
		state: 'recognized',
		source: 'user',
		confidence: null,
		defaulted: null
	});
});

test('edited merge summary preserves effective ids and provenance', async ({ page }) => {
	const state = await editableDrafts(page, [makeDraft(1), makeDraft(2), makeDraft(3)]);
	await editDialog(page).getByRole('button', { name: '合併', exact: true }).click();
	await editDialog(page).getByRole('checkbox', { name: '選取第 1 筆', exact: true }).check();
	await editDialog(page).getByRole('checkbox', { name: '選取第 2 筆', exact: true }).check();
	await editDialog(page).getByRole('button', { name: '合併所選 (2)', exact: true }).click();
	await editDialog(page).getByRole('button', { name: '編輯合併摘要', exact: true }).click();
	const panel = page.getByRole('dialog', { name: '編輯草稿 1/2', exact: true });
	await panel.locator('#content-input').fill('合併後摘要');
	await panel.locator('#amount-input').fill('350');
	await panel.getByRole('button', { name: '套用到草稿', exact: true }).click();
	await expect(editDialog(page).locator('[data-draft-card="summary"]')).toContainText('NT$ 350');
	await expect(editDialog(page).locator('[data-draft-card="summary"]')).toContainText(
		'合併後摘要'
	);
	await editDialog(page)
		.getByRole('button', { name: '完成，回到對話（2 筆）', exact: true })
		.click();
	await commitDrafts(page, 2).click();
	await expect.poll(() => state.posts.filter((post) => post.action === 'commit').length).toBe(1);
	const merged = state.posts.find((post) => post.action === 'commit')!.drafts![0];
	expect(merged.draftId).toBe(makeDraft(1).draftId);
	expect(merged.mergedFrom).toEqual([makeDraft(1).draftId, makeDraft(2).draftId]);
	expect(merged.amount.value).toBe(350);
	expect(merged.note.value).toBe('合併後摘要');
});

test('draft model recalculates saved summaries and controls merged identity', () => {
	const ctx = {
		today: '2026-10-01',
		categoryIds: new Set([categoryId]),
		allowedEmails: [user.email, 'b@example.test'],
		currentUserEmail: user.email
	};
	const first = makeDraft(1);
	const second = makeDraft(2);
	second.note.value = first.note.value;
	const session = fromServerDrafts([first, second]);
	const merged = effectiveDrafts(session, ctx)[0];
	session.groupSummaries[session.items[0].groupId!] = {
		...merged,
		draftId: makeDraft(9).draftId,
		mergedFrom: [makeDraft(9).draftId],
		amount: { value: 0, state: 'recognized', source: 'user', confidence: null },
		issues: [],
		status: 'complete'
	};
	const invalid = effectiveDrafts(session, ctx)[0];
	expect(invalid.draftId).toBe(first.draftId);
	expect(invalid.mergedFrom).toEqual([first.draftId, second.draftId]);
	expect(invalid.status).toBe('incomplete');
	expect(invalid.issues).toEqual([{ field: 'amount', code: 'invalid' }]);
	session.groupSummaries[session.items[0].groupId!].amount.value = 350;
	expect(effectiveDrafts(session, ctx)[0].status).toBe('complete');
	expect(effectiveDrafts(session, ctx)[0].amount.value).toBe(350);
});

test('legacy create and edit dialogs retain amount, date, manual shares and delete controls', async ({
	page
}) => {
	await setup(page, async (route, body) => route.fulfill({ json: created(body!.requestId) }), [
		row
	]);
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	const day = page.locator('[data-date="2026-10-01"]');
	await day.getByRole('button', { name: '新增項目', exact: true }).click();
	const createPanel = page.getByRole('dialog', { name: '新增項目', exact: true });
	await expect(createPanel.getByLabel('金額', { exact: true })).toBeVisible();
	await expect(createPanel.locator('#date-input')).toBeDisabled();
	await expect(createPanel.getByRole('button', { name: '新增', exact: true })).toBeVisible();
	await expect(createPanel.getByRole('button', { name: '刪除', exact: true })).toHaveCount(0);
	await expect(createPanel.getByText('已辨識', { exact: true })).toHaveCount(0);
	await createPanel.getByRole('radio', { name: '家庭', exact: true }).click();
	await expect(createPanel.getByRole('button', { name: '平分', exact: true })).toBeVisible();
	await expect(createPanel.locator('input[name="a@example.test"]')).toBeEditable();
	await expect(createPanel.getByRole('checkbox', { name: '已結清', exact: true })).toBeEnabled();
	await createPanel.getByRole('button', { name: 'Close', exact: true }).click();
	await day.getByRole('button', { name: 'Edit', exact: true }).click();
	const editPanel = page.getByRole('dialog', { name: '編輯項目', exact: true });
	await expect(editPanel.getByLabel('金額', { exact: true })).toHaveValue('100');
	await expect(editPanel.locator('#date-input')).toBeEnabled();
	await expect(editPanel.getByRole('button', { name: '更新', exact: true })).toBeVisible();
	await expect(editPanel.getByRole('button', { name: '刪除', exact: true })).toBeVisible();
	await expect(editPanel.getByRole('button', { name: '套用到草稿', exact: true })).toHaveCount(0);
});

const pendingId = (index: number) => `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, '0')}`;
const pendingItem = (index: number, expiredAt: number | null = null): pendingStore.PendingItem => ({
	requestId: pendingId(index),
	submittedAt: Date.parse('2026-10-01T04:00:00Z'),
	kind: 'analyze',
	expiredAt
});
async function seedPending(page: Page, value: unknown) {
	await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
		key: pendingStore.pendingKey(user.id),
		value
	});
}
async function reopen(page: Page) {
	await page
		.locator('section[data-date="2026-10-01"]')
		.getByRole('button', { name: 'AI 記帳', exact: true })
		.click();
}

test('legacy pending migrates to expired metadata without querying and allows a fresh request', async ({
	page
}) => {
	await seedPending(page, { requestId: pendingId(1) });
	let queries = 0;
	const s = await setup(page, async (route, body) => {
		if (!body) {
			queries++;
			await route.abort();
		} else {
			await interrupted(route, body.requestId);
		}
	});
	expect(queries).toBe(0);
	await expect(page.getByText('結果待確認', { exact: true })).toHaveCount(0);
	await expect(page.getByLabel('記帳內容')).toBeEditable();
	expect(await pendingItems(page)).toEqual([
		{
			requestId: pendingId(1),
			submittedAt: null,
			kind: 'legacy',
			expiredAt: expect.any(Number)
		}
	]);
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	expect(s.posts[0].requestId).not.toBe(pendingId(1));
	expect(await pendingItems(page)).toHaveLength(2);
	expect(queries).toBe(0);
});

test('pending analyze permits a new conversation with its own request id and retains the first item', async ({
	page
}) => {
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const s = await setup(page, async (route, body) => {
		if (s.posts.length === 1) {
			await interrupted(route, body!.requestId);
		} else {
			await waiting;
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await page.getByLabel('記帳內容').fill('另一筆早餐50');
	await submit(page);
	await expect.poll(async () => (await pendingItems(page)).length).toBe(2);
	await expect.poll(() => s.posts.length).toBe(2);
	expect(s.posts[1].requestId).not.toBe(s.posts[0].requestId);
	release();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect((await pendingItems(page)).map((item) => item.requestId)).toEqual([
		s.posts[0].requestId
	]);
});

for (const full of [true, false]) {
	test(`pending limit counts only active items: blocked=${full}`, async ({ page }) => {
		const items = full
			? [1, 2, 3].map((i) => pendingItem(i))
			: [1, 2, 3].map((i) => pendingItem(i, 1)).concat([4, 5].map((i) => pendingItem(i)));
		await seedPending(page, { v: 2, items });
		const s = await setup(page, async (route, body) => interrupted(route, body!.requestId));
		const before = await pending(page);
		await page.getByLabel('記帳內容').fill('保留午餐100');
		if (full) {
			await attach(page);
		}
		await submit(page);
		if (full) {
			await expect(limitToast(page)).toHaveText('已有3筆待確認，暫時無法建立新對話');
			expect(s.posts).toHaveLength(0);
			await expect(page.getByRole('img', { name: '第 1 張附圖' })).toBeVisible();
			expect(await pending(page)).toBe(before);
			await expect(page.getByLabel('記帳內容')).toHaveValue('保留午餐100');
			await expect(page.getByLabel('記帳內容')).toBeEditable();
		} else {
			await expect(limitToast(page)).toHaveCount(0);
			await expect.poll(() => s.posts.length).toBe(1);
			await expect.poll(async () => (await pendingItems(page)).length).toBe(6);
		}
	});
}

for (const outcome of ['not_found', 'failure', 'completed'] as const) {
	test(`pending expiry requires a not_found query after ten minutes: ${outcome}`, async ({
		page
	}) => {
		let fail = false;
		await setup(page, async (route, body) => {
			if (body) {
				await interrupted(route, body.requestId);
			} else if (fail && outcome === 'failure') {
				await route.abort();
			} else {
				await route.fulfill({
					json:
						fail && outcome === 'completed'
							? {
									status: 'completed',
									requestId: route.request().url().split('/').at(-1),
									expenses: [row],
									replayed: true
								}
							: {
									status: 'not_found',
									requestId: route.request().url().split('/').at(-1)
								}
				});
			}
		});
		await submit(page);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await page.clock.setFixedTime(new Date('2026-10-01T12:09:00+08:00'));
		await trayAction(page, '查詢結果');
		await expect(
			trayRows(page).first().getByRole('button', { name: '查詢結果', exact: true })
		).toBeEnabled();
		await expect(trayRows(page).first()).toContainText('尚未查到完成結果。');
		fail = true;
		await page.clock.setFixedTime(new Date('2026-10-01T12:10:00+08:00'));
		await trayAction(page, '查詢結果');
		if (outcome === 'not_found') {
			await expect(trayRows(page).first()).toHaveText(/^\s*已過期\s*$/);
			await expect(
				trayRows(page).first().getByRole('button', { name: '關閉已過期項目', exact: true })
			).toBeVisible();
			expect((await pendingItems(page))[0].expiredAt).toEqual(expect.any(Number));
			await expect(page.getByRole('button', { name: '重試同一請求' })).toHaveCount(0);
			await expect(page.getByRole('button', { name: '待確認', exact: true })).toBeVisible();
			await expect(page.getByLabel('助手訊息').filter({ hasText: '已過期' })).toHaveCount(0);
			await expect(page.getByLabel('記帳內容')).toBeEditable();
		} else if (outcome === 'completed') {
			await expect(createdSummary(page)).toContainText('已記帳 1 筆');
			await expect(pendingBadge(page)).toHaveCount(0);
			expect(await pending(page)).toBeNull();
		} else {
			await expect(trayRows(page).first()).toContainText(
				'連線中斷或逾時，請查詢結果或重試同一請求。'
			);
			await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
			expect((await pendingItems(page))[0].expiredAt).toBeNull();
		}
	});
}

test('same page close preserves the full pending analyze retry; reload keeps query only', async ({
	page
}) => {
	const s = await setup(page, async (route, body) => interrupted(route, body!.requestId));
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await reopen(page);
	await trayAction(page, '重試同一請求');
	await expect.poll(() => s.posts.length).toBe(2);
	expect(s.posts[1]).toEqual(s.posts[0]);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await page.reload();
	await reopen(page);
	await expandPending(page);
	await expect(page.getByRole('button', { name: '重試同一請求', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: '查詢結果', exact: true })).toBeVisible();
});

for (const changed of [false, true]) {
	test(`analyze connection failure before persisting retries same content id only: changed=${changed}`, async ({
		page
	}) => {
		const s = await setup(page, async (route, body) =>
			s.posts.length === 1 ? route.abort() : route.fulfill({ json: created(body!.requestId) })
		);
		await submit(page);
		await expect(page.getByText('未新增', { exact: true })).toBeVisible();
		expect(await pending(page)).toBeNull();
		await page.getByRole('button', { name: '修改後重新送出' }).click();
		if (changed) {
			await page.getByLabel('記帳內容').fill('早餐50');
		}
		await submit(page);
		await expect(page.getByText('已新增', { exact: true })).toBeVisible();
		if (changed) {
			expect(s.posts[1].requestId).not.toBe(s.posts[0].requestId);
		} else {
			expect(s.posts[1]).toEqual(s.posts[0]);
		}
	});
}
for (const format of ['json', 'sse', 'timeout'] as const) {
	test(`analyze ${format} failure without persisting cannot create uncertainty`, async ({
		page
	}) => {
		await setup(page, async (route) => {
			if (format === 'timeout') {
				return;
			}
			if (format === 'json') {
				await route.fulfill({
					status: 503,
					json: { error: { code: 'persist_uncertain', uncertain: true } }
				});
			} else {
				await route.fulfill({
					contentType: 'text/event-stream',
					body: 'event: error\ndata: {"error":{"code":"persist_uncertain","uncertain":true}}\n\n'
				});
			}
		});
		if (format === 'timeout') {
			await shortenTimeout(page);
		}
		await submit(page);
		await expect(page.getByText('未新增', { exact: true })).toBeVisible();
		await expect(page.getByText('結果待確認', { exact: true })).toHaveCount(0);
		expect(await pending(page)).toBeNull();
	});
}

test('commit timeout before persisting preserves unchanged payload id for retry', async ({
	page
}) => {
	let commits = 0;
	const s = await setup(page, async (route, body) => {
		if (body!.action === 'analyze') {
			await route.fulfill({ json: draftResponse(body!.requestId, [1, 2, 3].map(makeDraft)) });
		} else if (++commits > 1) {
			await route.fulfill({ json: { ...created(body!.requestId), expenses: batchRows } });
		}
	});
	await startDrafts(page);
	await shortenTimeout(page);
	await commitDrafts(page).click();
	await expect(page.getByText(/未記帳：/)).toBeVisible();
	await expect(page.getByText('無法確認是否已記帳', { exact: true })).toHaveCount(0);
	expect(await pending(page)).toBeNull();
	await commitDrafts(page).click();
	await expect(page.getByRole('group', { name: '已記帳摘要' })).toBeVisible();
	expect(s.posts[2]).toEqual(s.posts[1]);
});

for (const kind of ['text', 'image', 'commit'] as const) {
	test(`pending ${kind} metadata stores only permitted fields and no private outputs`, async ({
		page
	}) => {
		const longText = '🍜一二三四五六七八九十甲乙丙完整內容';
		const s = await setup(page, async (route, body) => {
			if (kind === 'commit' && body!.action === 'analyze') {
				await route.fulfill({
					json: draftResponse(body!.requestId, [1, 2, 3].map(makeDraft))
				});
			} else {
				await interrupted(route, body!.requestId);
			}
		});
		if (kind === 'commit') {
			await startDrafts(page);
			await commitDrafts(page).click();
		} else {
			await page.getByLabel('記帳內容').fill(kind === 'text' ? longText : '');
			if (kind === 'image') {
				await mockUploads(page);
				await attach(page);
			}
			await submit(page);
		}
		await expect.poll(async () => (await pendingItems(page)).length).toBe(1);
		const item = (await pendingItems(page))[0];
		expect(
			Object.keys(item).every((key) =>
				[
					'requestId',
					'submittedAt',
					'kind',
					'snippet',
					'imageCount',
					'draftCount',
					'expiredAt'
				].includes(key)
			)
		).toBe(true);
		const raw = (await pending(page))!;
		expect(raw).not.toContain(longText);
		expect(raw).not.toContain(imagePath);
		expect(raw).not.toContain('合成帳目');
		expect(raw).not.toContain('Gemini');
		if (kind === 'text') {
			expect(item.snippet).toBe([...longText].slice(0, 12).join(''));
		} else {
			expect(item.snippet).toBeUndefined();
		}
		if (kind === 'image') {
			expect(item.imageCount).toBe(1);
		}
		if (kind === 'commit') {
			expect(item.draftCount).toBe(3);
			expect(item.imageCount).toBeUndefined();
		}
		await expect.poll(() => s.posts.length).toBeGreaterThan(kind === 'commit' ? 1 : 0);
		expect(item.requestId).toBe(s.posts.at(-1)!.requestId);
	});
}

test('revise with another pending item uses a fresh id and leaves the pending list unchanged', async ({
	page
}) => {
	await seedPending(page, { v: 2, items: [pendingItem(1)] });
	const drafts = [1, 2, 3].map(makeDraft);
	const s = await setup(page, async (route, body) => {
		if (body!.action === 'revise') {
			drafts[2] = { ...drafts[2], note: { ...drafts[2].note, value: '午餐' }, updated: true };
		}
		await route.fulfill({ json: draftResponse(body!.requestId, drafts) });
	});
	await submit(page);
	await expect(draftBlock(page)).toBeVisible();
	const before = await pending(page);
	await page.getByLabel('補充草稿').fill('第三筆是午餐');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(draftBlock(page)).toContainText('剛更新');
	expect(s.posts[1].action).toBe('revise');
	expect(s.posts[1].requestId).not.toBe(s.posts[0].requestId);
	expect(s.posts[1].requestId).not.toBe(pendingId(1));
	expect(await pending(page)).toBe(before);
});

function fakeStorage(raw?: string) {
	const values = new Map<string, string>();
	if (raw !== undefined) {
		values.set(pendingStore.pendingKey('owner'), raw);
	}
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
}

test('pending parser migrates legacy and strips invalid, duplicate and extra data', () => {
	const legacy = { requestId: pendingId(1) };
	expect(pendingStore.parsePending(legacy, 100)).toEqual({
		items: [{ ...legacy, kind: 'legacy', submittedAt: null, expiredAt: 100 }],
		migrated: true
	});
	for (const raw of [null, [], { v: 3, items: [] }, { requestId: 'bad' }]) {
		expect(pendingStore.parsePending(raw, 100).items).toEqual([]);
	}
	const good = pendingItem(1);
	const invalid = [
		{ ...good, requestId: 'bad' },
		{ ...good, kind: 'other' },
		{ ...good, submittedAt: Infinity },
		{ ...good, snippet: 12 },
		{ ...good, snippet: '字'.repeat(13) },
		{ ...good, imageCount: -1 },
		{ ...good, draftCount: 0.5 },
		{ ...good, kind: 'legacy', submittedAt: null, expiredAt: null }
	];
	expect(
		pendingStore.parsePending(
			{ v: 2, items: [...invalid, { ...good, fullText: 'private' }, good] },
			100
		).items
	).toEqual([good]);
	const storage = fakeStorage('{bad');
	expect(pendingStore.load('owner', 100, storage)).toEqual([]);
	expect(storage.getItem(pendingStore.pendingKey('owner'))).toBeNull();
	storage.setItem(
		pendingStore.pendingKey('owner'),
		JSON.stringify({ v: 2, items: [{ ...good, fullText: 'private' }, good] })
	);
	expect(pendingStore.load('owner', 100, storage)).toEqual([good]);
	expect(JSON.parse(storage.getItem(pendingStore.pendingKey('owner'))!)).toEqual({
		v: 2,
		items: [good]
	});
	const throwing = {
		...storage,
		getItem: () => {
			throw new Error('read failed');
		}
	};
	expect(() => pendingStore.load('owner', 100, throwing)).toThrow('read failed');
});

test('pending mutations reject duplicate ids and remove only seen expired items', () => {
	const storage = fakeStorage();
	const item = pendingItem(1);
	expect(pendingStore.add('owner', item, 100, storage)).not.toBe(false);
	expect(pendingStore.add('owner', { ...item, snippet: 'changed' }, 100, storage)).toBe(false);
	expect(pendingStore.load('owner', 100, storage)).toEqual([item]);
	pendingStore.add('owner', pendingItem(2), 100, storage);
	pendingStore.add('owner', pendingItem(3, 20), 100, storage);
	pendingStore.markExpired('owner', item.requestId, 100, storage);
	pendingStore.markExpired('owner', item.requestId, 200, storage);
	expect(pendingStore.load('owner', 200, storage)[0].expiredAt).toBe(100);
	pendingStore.removeSeenExpired('owner', [pendingId(1), pendingId(2)], storage);
	expect(pendingStore.load('owner', 200, storage).map((item) => item.requestId)).toEqual([
		pendingId(2),
		pendingId(3)
	]);
	pendingStore.remove('owner', pendingId(2), storage);
	pendingStore.remove('owner', pendingId(3), storage);
	expect(storage.getItem(pendingStore.pendingKey('owner'))).toBeNull();
	pendingStore.save('owner', [item], storage);
	pendingStore.save('owner', [], storage);
	expect(storage.getItem(pendingStore.pendingKey('owner'))).toBeNull();
});

test('pending time window, active count and Unicode snippet use exact boundaries', () => {
	const item = { ...pendingItem(1), submittedAt: 1000 };
	expect(pendingStore.activeCount([item, pendingItem(2, 10)])).toBe(1);
	expect(pendingStore.isPastWindow(item, 600999)).toBe(false);
	expect(pendingStore.isPastWindow(item, 601000)).toBe(true);
	expect(pendingStore.isPastWindow(item, 999)).toBe(false);
	expect(
		pendingStore.isPastWindow(
			{ ...item, kind: 'legacy', submittedAt: null, expiredAt: 1 },
			1000000
		)
	).toBe(false);
	const text = ' 🍜e\u0301一二三四五六七八九十 ';
	expect(pendingStore.snippetOf(text)).toBe([...text.trim()].slice(0, 12).join(''));
	expect(pendingStore.snippetOf('  \n ')).toBeUndefined();
});

test('semantic timeout constants follow service deadlines and Cloud Run cap', () => {
	expect(SEMANTIC_TIMEOUT_MS).toBe(45000);
	expect(SEMANTIC_IMAGE_TIMEOUT_MS).toBe(95000);
	expect(SEMANTIC_TIMEOUT_MS).toBeGreaterThanOrEqual(SERVICE_TEXT_DEADLINE_MS + 15000);
	expect(
		SEMANTIC_IMAGE_TIMEOUT_MS >= SERVICE_IMAGE_DEADLINE_MS + 15000 ||
			SEMANTIC_IMAGE_TIMEOUT_MS === CLOUD_RUN_TIMEOUT_MS + 5000
	).toBe(true);
	expect(SEMANTIC_TIMEOUT_MS).toBeLessThanOrEqual(CLOUD_RUN_TIMEOUT_MS + 5000);
	expect(SEMANTIC_IMAGE_TIMEOUT_MS).toBeLessThanOrEqual(CLOUD_RUN_TIMEOUT_MS + 5000);
});

for (const image of [false, true]) {
	test(`semantic fetch uses the configured ${image ? 'image' : 'text'} AbortSignal timeout`, async ({
		page
	}) => {
		await setup(page, async (route, body) => route.fulfill({ json: created(body!.requestId) }));
		await page.evaluate(() => {
			const original = AbortSignal.timeout;
			const calls: number[] = [];
			Object.defineProperty(window, 'semanticTimeoutCalls', { value: calls });
			AbortSignal.timeout = (ms) => {
				calls.push(ms);
				return original(ms);
			};
		});
		if (image) {
			await mockUploads(page);
			await attach(page);
		}
		await submit(page);
		await expect(
			image
				? page.getByRole('group', { name: '已記帳摘要' })
				: page.getByText('已新增', { exact: true })
		).toBeVisible();
		const calls = await page.evaluate(() => Reflect.get(window, 'semanticTimeoutCalls'));
		expect(calls).toContain(image ? SEMANTIC_IMAGE_TIMEOUT_MS : SEMANTIC_TIMEOUT_MS);
	});
}

test('editing drafts after a pre-persist commit failure creates a fresh commit id', async ({
	page
}) => {
	let commits = 0;
	const s = await setup(page, async (route, body) => {
		if (body!.action === 'analyze') {
			await route.fulfill({ json: draftResponse(body!.requestId, [1, 2, 3].map(makeDraft)) });
		} else if (++commits === 1) {
			await route.abort();
		} else {
			await route.fulfill({
				json: { ...created(body!.requestId), expenses: batchRows.slice(1) }
			});
		}
	});
	await startDrafts(page);
	await commitDrafts(page).click();
	await expect(page.getByText(/未記帳：/)).toBeVisible();
	await openDraftEditor(page);
	await draftCards(page).nth(0).getByRole('button', { name: '排除', exact: true }).click();
	await editDialog(page)
		.getByRole('button', { name: '完成，回到對話（2 筆）', exact: true })
		.click();
	await commitDrafts(page, 2).click();
	await expect(page.getByRole('group', { name: '已記帳摘要' })).toBeVisible();
	expect(s.posts[2].requestId).not.toBe(s.posts[1].requestId);
	expect(s.posts[2].drafts).toHaveLength(2);
	expect(await pending(page)).toBeNull();
});

for (const revise of ['failed', 'changed'] as const) {
	test(`commit after a pre-persist commit failure and a ${revise} revise ${revise === 'failed' ? 'reuses' : 'replaces'} the commit id`, async ({
		page
	}) => {
		const drafts = [1, 2, 3].map(makeDraft);
		let commits = 0;
		const s = await setup(page, async (route, body) => {
			if (body!.action === 'analyze') {
				await route.fulfill({ json: draftResponse(body!.requestId, drafts) });
			} else if (body!.action === 'revise') {
				if (revise === 'failed') {
					await route.abort();
				} else {
					const next = drafts.map((draft, index) =>
						index === 2 ? { ...draft, note: { ...draft.note, value: '午餐' } } : draft
					);
					await route.fulfill({ json: draftResponse(body!.requestId, next) });
				}
			} else if (++commits === 1) {
				await route.abort();
			} else {
				await route.fulfill({ json: { ...created(body!.requestId), expenses: batchRows } });
			}
		});
		await startDrafts(page);
		await commitDrafts(page).click();
		await expect(page.getByText(/未記帳：/)).toBeVisible();
		await page.getByLabel('補充草稿').fill('第三筆是午餐');
		await page.getByRole('button', { name: '送出補充', exact: true }).click();
		if (revise === 'failed') {
			await expect(page.getByText(/沒有更新草稿：/)).toBeVisible();
		} else {
			await expect(page.getByText('已更新草稿。', { exact: true })).toBeVisible();
		}
		await commitDrafts(page).click();
		await expect(page.getByRole('group', { name: '已記帳摘要' })).toBeVisible();
		expect(s.posts.map((post) => post.action)).toEqual([
			'analyze',
			'commit',
			'revise',
			'commit'
		]);
		const [, first, , second] = s.posts;
		if (revise === 'failed') {
			expect(second.requestId).toBe(first.requestId);
			expect(second.referenceDate).toBe(first.referenceDate);
			expect(second.drafts).toEqual(first.drafts);
			expect(second).toEqual(first);
		} else {
			expect(second.requestId).not.toBe(first.requestId);
			expect(second.drafts).not.toEqual(first.drafts);
		}
		expect(await pending(page)).toBeNull();
	});
}

test('account switch while the dialog is closed leaves only lookup for the pending item', async ({
	page
}) => {
	const s = await setup(page, async (route, body) => interrupted(route, body!.requestId));
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	const original = await pending(page);
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	// The header avatar initial shows which account the store holds while the dialog is closed.
	const avatar = page.locator('header .rounded-full').last();
	await expect(avatar).toHaveText('S');
	const switchAccount = (other: boolean) =>
		page.evaluate(
			({ storageKey, session, other }) => {
				const next = other
					? {
							...session,
							user: {
								...session.user,
								id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
								email: 'b@example.test',
								user_metadata: { name: 'Other' }
							}
						}
					: session;
				localStorage.setItem(storageKey, JSON.stringify(next));
				const channel = new BroadcastChannel(storageKey);
				channel.postMessage({ event: 'SIGNED_IN', session: next });
				channel.close();
			},
			{ storageKey: s.storageKey, session: s.session, other }
		);
	await switchAccount(true);
	await expect(avatar).toHaveText('O');
	await switchAccount(false);
	await expect(avatar).toHaveText('S');
	await reopen(page);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	await expandPending(page);
	await expect(page.getByRole('button', { name: '查詢結果', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '重試同一請求', exact: true })).toHaveCount(0);
	expect(await pending(page)).toBe(original);
	expect(s.posts).toHaveLength(1);
});

test('clarification failure before persisting retains the same answered request id and history', async ({
	page
}) => {
	let round = 0;
	const question = '金額是多少？';
	const s = await setup(page, async (route, body) => {
		if (++round === 1) {
			await route.fulfill({
				json: {
					status: 'needs_input',
					requestId: body!.requestId,
					question,
					issues: [{ field: 'amount', code: 'missing' }]
				}
			});
		} else if (round === 2) {
			await route.abort();
		} else {
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	await submit(page);
	await page.getByLabel('補充資訊').fill('100');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(page.getByText('未新增', { exact: true })).toBeVisible();
	expect(await pending(page)).toBeNull();
	await page.getByRole('button', { name: '修改後重新送出' }).click();
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts[2]).toEqual(s.posts[1]);
	expect(s.posts[2].requestId).toBe(s.posts[0].requestId);
	expect(s.posts[2].history).toEqual([{ question, answer: '100' }]);
});

for (const lifecycle of ['pagehide', 'account-switch'] as const) {
	for (const recovery of ['query', 'retry'] as const) {
		test(`original uncertainty survives ${lifecycle} during an in-flight ${recovery} before new persisting`, async ({
			page
		}) => {
			let started = false;
			let posts = 0;
			const s = await setup(page, async (route, body) => {
				if (body && ++posts === 1) {
					await interrupted(route, body.requestId);
				} else {
					// Leave this recovery request in flight without any new persisting event.
					started = true;
				}
			});
			await submit(page);
			await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
			const original = await pending(page);
			await trayAction(page, recovery === 'query' ? '查詢結果' : '重試同一請求');
			await expect.poll(() => started).toBe(true);
			if (recovery === 'retry') {
				await expect(page.getByRole('dialog').locator('textarea')).toBeDisabled();
			} else {
				// A tray lookup runs beside the conversation and does not lock the composer.
				await expect(
					trayRows(page).first().getByRole('button', { name: '查詢結果', exact: true })
				).toHaveAttribute('aria-busy', 'true');
				await expect(page.getByRole('dialog').locator('textarea')).toBeEditable();
			}
			if (lifecycle === 'pagehide') {
				await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
				await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
				expect(await pending(page)).toBe(original);
			} else {
				const switchAccount = (other: boolean) =>
					page.evaluate(
						({ storageKey, session, other }) => {
							const next = other
								? {
										...session,
										user: {
											...session.user,
											id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
											email: 'b@example.test'
										}
									}
								: session;
							localStorage.setItem(storageKey, JSON.stringify(next));
							const channel = new BroadcastChannel(storageKey);
							channel.postMessage({ event: 'SIGNED_IN', session: next });
							channel.close();
						},
						{ storageKey: s.storageKey, session: s.session, other }
					);
				await switchAccount(true);
				await expect(page.getByText('結果待確認', { exact: true })).toHaveCount(0);
				await expect(page.getByLabel('記帳內容')).toBeEditable();
				expect(await pending(page)).toBe(original);
				await switchAccount(false);
				await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
				await expandPending(page);
				await expect(
					page.getByRole('button', { name: '查詢結果', exact: true })
				).toBeVisible();
				await expect(
					page.getByRole('button', { name: '重試同一請求', exact: true })
				).toHaveCount(0);
				expect(await pending(page)).toBe(original);
			}
			expect(s.posts).toHaveLength(recovery === 'retry' ? 2 : 1);
		});
	}
}

test('changed clarification answer after pre-persist failure gets a new id and original Taiwan date', async ({
	page
}) => {
	let round = 0;
	const question = '金額是多少？';
	const s = await setup(page, async (route, body) => {
		if (++round === 1) {
			await route.fulfill({
				json: {
					status: 'needs_input',
					requestId: body!.requestId,
					question,
					issues: [{ field: 'amount', code: 'missing' }]
				}
			});
		} else if (round === 2) {
			await route.abort();
		} else {
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	await page.clock.setFixedTime(new Date('2026-10-01T23:59:00+08:00'));
	await submit(page);
	await page.getByLabel('補充資訊').fill('100');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(page.getByText('未新增', { exact: true })).toBeVisible();
	expect(await pending(page)).toBeNull();
	await page.clock.setFixedTime(new Date('2026-10-02T00:01:00+08:00'));
	await page.getByRole('button', { name: '修改後重新送出', exact: true }).click();
	await page.getByLabel('補充資訊').fill('120');
	await page.getByRole('button', { name: '送出補充', exact: true }).click();
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	expect(s.posts[2].requestId).not.toBe(s.posts[1].requestId);
	expect(s.posts[2].referenceDate).toBe(s.posts[1].referenceDate);
	expect(s.posts[2].referenceDate).toBe('2026-10-01');
	expect(s.posts[2].history).toEqual([{ question, answer: '120' }]);
	expect(s.posts[2].text).toBe(s.posts[1].text);
	expect(await pending(page)).toBeNull();
});

// Issue #52 PR2: variant A badge, popover tray, delete confirmation, expiry and toast.
const taipei = (time: string) => Date.parse(`2026-10-01T${time}+08:00`);
const statusJson = (route: Route, status: 'not_found' | 'completed', expenses = [row]) =>
	route.fulfill({
		json:
			status === 'completed'
				? {
						status,
						requestId: route.request().url().split('/').at(-1),
						expenses,
						replayed: true
					}
				: { status, requestId: route.request().url().split('/').at(-1) }
	});
const switchTo = (page: Page, s: { storageKey: string; session: unknown }, other: boolean) =>
	page.evaluate(
		({ storageKey, session, other }) => {
			const base = session as { user: Record<string, unknown> };
			const next = other
				? {
						...base,
						user: {
							...base.user,
							id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
							email: 'b@example.test'
						}
					}
				: base;
			localStorage.setItem(storageKey, JSON.stringify(next));
			const channel = new BroadcastChannel(storageKey);
			channel.postMessage({ event: 'SIGNED_IN', session: next });
			channel.close();
		},
		{ storageKey: s.storageKey, session: s.session, other }
	);

for (const close of ['escape', 'dismiss'] as const) {
	test(`tray legacy item shows only expired and is cleared by ${close}`, async ({ page }) => {
		await seedPending(page, { requestId: pendingId(1) });
		let queries = 0;
		await setup(page, async (route) => {
			queries++;
			await route.abort();
		});
		const badge = page.getByRole('button', { name: '待確認', exact: true });
		await expect(badge).toBeVisible();
		await expect(badge).toHaveText('待確認');
		await expect(badge).toHaveClass(/bg-\[#fef3c7\]/);
		await badge.click();
		await expect(pendingTray(page)).toContainText('待確認');
		await expect(pendingTray(page)).not.toContainText(/待確認 \d/);
		await expect(trayRows(page)).toHaveCount(1);
		await expect(trayRows(page).first()).toHaveText('已過期');
		await expect(trayRows(page).first().getByRole('button')).toHaveAccessibleName(
			'關閉已過期項目'
		);
		if (close === 'escape') {
			await page.keyboard.press('Escape');
			await expect(pendingTray(page)).toHaveCount(0);
			await expect(page.getByRole('dialog')).toBeVisible();
		} else {
			await page.getByRole('button', { name: '關閉已過期項目', exact: true }).click();
			await expect(pendingTray(page)).toHaveCount(0);
		}
		expect(await pendingItems(page)).toEqual([]);
		await expect(badge).toHaveCount(0);
		await expect(page.getByLabel('記帳內容')).toBeEditable();
		expect(queries).toBe(0);
	});
}

test('tray rows show Taipei time, kind, snippet and close only the popover', async ({ page }) => {
	await seedPending(page, {
		v: 2,
		items: [
			{
				requestId: pendingId(1),
				submittedAt: taipei('11:58:00'),
				kind: 'analyze',
				snippet: '🍜一二三四五六七八九十甲',
				expiredAt: null
			},
			{
				requestId: pendingId(2),
				submittedAt: taipei('11:59:00'),
				kind: 'analyze',
				imageCount: 2,
				expiredAt: null
			},
			{
				requestId: pendingId(3),
				submittedAt: taipei('11:57:00'),
				kind: 'commit',
				draftCount: 3,
				expiredAt: null
			},
			{
				requestId: pendingId(4),
				submittedAt: taipei('11:40:00'),
				kind: 'analyze',
				snippet: '早餐',
				expiredAt: taipei('11:55:00')
			}
		]
	});
	const s = await setup(page, async (route) => statusJson(route, 'not_found'));
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 3 筆');
	await expect(pendingBadge(page)).toHaveText('待確認3');
	await pendingBadge(page).click();
	await expect(pendingBadge(page)).toHaveAttribute('aria-expanded', 'true');
	await expect(pendingTray(page)).toContainText('待確認 3 筆');
	await expect(pendingTray(page)).toContainText('點一筆展開');
	await expect(trayRows(page)).toHaveText([
		/^（圖片，未存文字）\s*10\/01 11:59 送出\s*圖片 2 張\s*待確認\s*$/,
		/^🍜一二三四五六七八九十甲…\s*10\/01 11:58 送出\s*文字\s*待確認\s*$/,
		/^（草稿，未存內容）\s*10\/01 11:57 送出\s*確認 3 筆草稿\s*待確認\s*$/,
		/^\s*已過期\s*$/
	]);
	await expect(page.getByRole('button', { name: '查詢結果' })).toHaveCount(0);
	await expandPending(page, 1);
	await expect(trayRows(page).nth(1)).toContainText('尚未查到完成結果。');
	for (const name of ['查詢結果', '刪除這筆待確認']) {
		const button = trayRows(page).nth(1).getByRole('button', { name, exact: true });
		await expect(button).toHaveAttribute('title', name);
		const box = (await button.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(36);
		expect(box.height).toBeGreaterThanOrEqual(36);
	}
	const dismiss = trayRows(page).nth(3).getByRole('button', { name: '關閉已過期項目' });
	await expect(dismiss).toHaveAttribute('title', '關閉已過期項目');
	expect((await dismiss.boundingBox())!.height).toBeGreaterThanOrEqual(36);
	// Outside click inside the AI dialog closes only the popover and clears seen expired items.
	await page.getByLabel('記帳內容').click();
	await expect(pendingTray(page)).toHaveCount(0);
	await expect(page.getByRole('dialog')).toBeVisible();
	expect((await pendingItems(page)).map((item) => item.requestId)).toEqual([
		pendingId(1),
		pendingId(2),
		pendingId(3)
	]);
	// Outside click on the scrim also closes only the popover.
	await pendingBadge(page).click();
	await expect(pendingTray(page)).toBeVisible();
	await page.mouse.click(2, 2);
	await expect(pendingTray(page)).toHaveCount(0);
	await expect(page.getByRole('dialog')).toBeVisible();
	// The badge toggles the popover and Escape closes it before the AI dialog.
	await pendingBadge(page).click();
	await pendingBadge(page).click();
	await expect(pendingTray(page)).toHaveCount(0);
	await pendingBadge(page).click();
	await page.keyboard.press('Escape');
	await expect(pendingTray(page)).toHaveCount(0);
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(s.posts).toHaveLength(0);
});

test('a new entry while pending adds a badge item with its own request id', async ({ page }) => {
	const s = await setup(page, async (route, body) => interrupted(route, body!.requestId));
	await expect(pendingBadge(page)).toHaveCount(0);
	await submit(page);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	await page.getByLabel('記帳內容').fill('另一筆早餐50');
	await submit(page);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 2 筆');
	await expect.poll(() => s.posts.length).toBe(2);
	expect(s.posts[1].requestId).not.toBe(s.posts[0].requestId);
	expect((await pendingItems(page)).map((item) => item.requestId)).toEqual([
		s.posts[0].requestId,
		s.posts[1].requestId
	]);
	await openPendingTray(page);
	await expect(trayRows(page).nth(0)).toContainText('另一筆早餐50');
	await expect(trayRows(page).nth(1)).toContainText('午餐100');
	await expect(trayRows(page).nth(0)).toContainText('10/01 12:00 送出');
});

test('limit toast stays in the dialog, restarts without stacking and closes', async ({ page }) => {
	await seedPending(page, { v: 2, items: [1, 2, 3].map((i) => pendingItem(i)) });
	const s = await setup(
		page,
		async (route, body) => interrupted(route, body!.requestId),
		[],
		undefined,
		'install'
	);
	const before = await pending(page);
	await submit(page);
	const toast = limitToast(page);
	await expect(toast).toHaveText('已有3筆待確認，暫時無法建立新對話');
	await expect(toast).toHaveAttribute('aria-live', 'polite');
	await expect(toast.getByRole('button')).toHaveCount(1);
	await expect(toast.getByRole('button')).toHaveAccessibleName('關閉通知');
	await expect(toast.getByRole('button')).toHaveAttribute('title', '關閉通知');
	await expect(
		page.getByRole('dialog').getByRole('status').filter({ hasText: '已有3筆' })
	).toHaveCount(1);
	await page.clock.runFor(3_000);
	await submit(page);
	await expect(toast).toHaveCount(1);
	await page.clock.runFor(3_000);
	await expect(toast).toBeVisible();
	await page.clock.runFor(1_100);
	await expect(toast).toHaveCount(0);
	await submit(page);
	await expect(toast).toBeVisible();
	await toast.getByRole('button', { name: '關閉通知' }).click();
	await expect(toast).toHaveCount(0);
	expect(s.posts).toHaveLength(0);
	expect(await pending(page)).toBe(before);
	await expect(page.getByLabel('記帳內容')).toHaveValue('午餐100');
	await expect(pendingTray(page)).toHaveCount(0);
});

test('ten minutes plus a not_found check expires an item; the badge drops it and x removes it', async ({
	page
}) => {
	let queries = 0;
	await setup(
		page,
		async (route, body) => {
			if (body) {
				await interrupted(route, body.requestId);
			} else {
				queries++;
				await statusJson(route, 'not_found');
			}
		},
		[],
		undefined,
		'install'
	);
	await submit(page);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	// The badge appears before the POST; wait until the interrupted stream has settled into
	// the uncertain state so the fast-forward cannot fire the request timeout first.
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await expect(page.getByLabel('記帳內容')).toBeEditable();
	await page.clock.runFor(9 * 60_000);
	await trayAction(page, '查詢結果');
	await expect.poll(() => queries).toBeGreaterThan(0);
	await expect(trayRows(page).first()).toContainText('尚未查到完成結果。');
	expect((await pendingItems(page))[0].expiredAt).toBeNull();
	// The 60-second check runs the not_found lookup once the window has passed; the
	// submit happened a moment after the interval started, so allow one more tick.
	await page.clock.runFor(2 * 60_000);
	// §5: the expired row keeps only 已過期 and ×, without the snippet, time or kind.
	await expect(trayRows(page).first()).toHaveText(/^\s*已過期\s*$/);
	await expect(page.getByRole('button', { name: '待確認', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '查詢結果' })).toHaveCount(0);
	expect((await pendingItems(page))[0].expiredAt).toEqual(expect.any(Number));
	await page.getByRole('button', { name: '關閉已過期項目', exact: true }).click();
	await expect(pendingBadge(page)).toHaveCount(0);
	expect(await pendingItems(page)).toEqual([]);
});

test('seen expired items clear only when the tray closes', async ({ page }) => {
	await seedPending(page, {
		v: 2,
		items: [
			{ ...pendingItem(1), submittedAt: taipei('12:00:00') },
			{ ...pendingItem(2), submittedAt: taipei('12:05:00') }
		]
	});
	await setup(page, async (route) => statusJson(route, 'not_found'), [], undefined, 'install');
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 2 筆');
	// (a) Expired while the tray is closed: kept until the tray is opened and closed.
	await page.clock.runFor(10 * 60_000);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	expect((await pendingItems(page)).map((item) => item.expiredAt !== null)).toEqual([
		true,
		false
	]);
	await openPendingTray(page);
	await expect(trayRows(page).nth(1)).toHaveText(/^\s*已過期\s*$/);
	// (c) A reload while the tray is open is not a close.
	await page.reload();
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30000
	});
	expect(await pendingItems(page)).toHaveLength(2);
	await reopen(page);
	await openPendingTray(page);
	await page.keyboard.press('Escape');
	await expect(pendingTray(page)).toHaveCount(0);
	expect((await pendingItems(page)).map((item) => item.requestId)).toEqual([pendingId(2)]);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	// (b) Expired while the tray is open: shown at once, removed on close.
	await expandPending(page);
	// The 60-second check looks the item up once its window passes.
	await page.clock.runFor(5 * 60_000);
	await expect(trayRows(page).first()).toHaveText(/^\s*已過期\s*$/);
	await expect(page.getByRole('button', { name: '待確認', exact: true })).toBeVisible();
	await pendingBadge(page).click();
	await expect(pendingTray(page)).toHaveCount(0);
	// (d) An empty list hides the badge.
	expect(await pendingItems(page)).toEqual([]);
	await expect(pendingBadge(page)).toHaveCount(0);
});

for (const outcome of ['completed', 'not_found', 'failure'] as const) {
	test(`delete re-queries first: ${outcome}`, async ({ page }) => {
		await seedPending(page, { v: 2, items: [pendingItem(1)] });
		let queries = 0;
		await setup(page, async (route) => {
			queries++;
			if (outcome === 'failure') {
				await route.abort();
			} else {
				await statusJson(route, outcome);
			}
		});
		await trayAction(page, '刪除這筆待確認');
		await expect.poll(() => queries).toBe(1);
		const alert = page.getByRole('alertdialog');
		if (outcome === 'completed') {
			await expect(createdSummary(page)).toContainText('已記帳 1 筆');
			await expect(alert).toHaveCount(0);
			await expect(pendingBadge(page)).toHaveCount(0);
			expect(await pending(page)).toBeNull();
		} else if (outcome === 'failure') {
			await expect(trayRows(page).first()).toContainText(
				'連線中斷或逾時，請查詢結果或重試同一請求。'
			);
			await expect(alert).toHaveCount(0);
			expect(await pendingItems(page)).toHaveLength(1);
		} else {
			await expect(alert).toBeVisible();
			await expect(alert.getByRole('heading')).toHaveText('確定刪除這筆待確認？');
			await expect(alert).toContainText(
				'已重新查詢：仍未查到這筆記帳。它可能還在處理中，刪除後如果你重新記帳，可能會重複。'
			);
			await expect(alert.getByRole('button')).toHaveText(['取消', '仍要刪除']);
			await expect(alert.getByRole('button', { name: '取消' })).toBeFocused();
			await alert.getByRole('button', { name: '取消' }).click();
			await expect(alert).toHaveCount(0);
			await expect(pendingTray(page)).toBeVisible();
			expect(await pendingItems(page)).toHaveLength(1);
			// Escape closes only the confirmation.
			await trayAction(page, '刪除這筆待確認');
			await expect(alert).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(alert).toHaveCount(0);
			await expect(pendingTray(page)).toBeVisible();
			expect(await pendingItems(page)).toHaveLength(1);
			await trayAction(page, '刪除這筆待確認');
			await alert.getByRole('button', { name: '仍要刪除' }).click();
			await expect(alert).toHaveCount(0);
			await expect(pendingBadge(page)).toHaveCount(0);
			expect(await pendingItems(page)).toEqual([]);
			await expect(page.getByLabel('記帳內容')).toBeEditable();
		}
		await expect(page.getByRole('dialog', { name: 'AI 記帳' })).toBeVisible();
	});
}

test('streaming keeps the tray viewable but disables its actions', async ({ page }) => {
	await seedPending(page, { v: 2, items: [pendingItem(1)] });
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const s = await setup(page, async (route, body) => {
		await wait;
		await route.fulfill({ json: created(body!.requestId) });
	});
	await submit(page);
	await expect.poll(() => s.posts.length).toBe(1);
	// The in-flight request is listed first (same submit time, stored later); expand the seeded one.
	await expandPending(page, 1);
	await expect(page.getByRole('button', { name: '查詢結果', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: '刪除這筆待確認', exact: true })).toBeDisabled();
	release();
	await expect(page.getByRole('button', { name: '查詢結果', exact: true })).toBeEnabled();
});

test('Q8 commit query completes from the auto-opened tray and removes the stored item', async ({
	page
}) => {
	const s = await setup(page, async (route, body) => {
		if (!body) {
			await statusJson(route, 'completed', batchRows);
		} else if (body.action === 'analyze') {
			await route.fulfill({ json: draftResponse(body.requestId, [1, 2, 3].map(makeDraft)) });
		} else {
			await interrupted(route, body.requestId);
		}
	});
	await startDrafts(page);
	await commitDrafts(page).click();
	await expect(pendingTray(page)).toBeVisible();
	await expect(draftBlock(page)).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^全部記帳/ })).toHaveCount(0);
	s.setRows(batchRows);
	await trayAction(page, '查詢結果');
	await expect(createdSummary(page)).toContainText('已記帳 3 筆');
	await expect(pendingTray(page)).toHaveCount(0);
	await expect(pendingBadge(page)).toHaveCount(0);
	expect(await pending(page)).toBeNull();
	expect(s.posts.filter((post) => post.action === 'commit')).toHaveLength(1);
});

test('account switch hides pending items and expiry uses the original submit time', async ({
	page
}) => {
	await seedPending(page, { v: 2, items: [pendingItem(1)] });
	const s = await setup(
		page,
		async (route) => statusJson(route, 'not_found'),
		[],
		undefined,
		'install'
	);
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
	await switchTo(page, s, true);
	await expect(pendingBadge(page)).toHaveCount(0);
	await page.clock.runFor(10 * 60_000);
	await switchTo(page, s, false);
	await expect(page.getByRole('button', { name: '待確認', exact: true })).toBeVisible();
	const [item] = await pendingItems(page);
	expect(item.submittedAt).toBe(taipei('12:00:00'));
	expect(item.expiredAt).toEqual(expect.any(Number));
});

test('a device clock earlier than submit time never expires the item', async ({ page }) => {
	await seedPending(page, {
		v: 2,
		items: [{ ...pendingItem(1), submittedAt: taipei('12:30:00') }]
	});
	let queries = 0;
	await setup(
		page,
		async (route) => {
			queries++;
			await statusJson(route, 'not_found');
		},
		[],
		undefined,
		'install'
	);
	await page.clock.runFor(2 * 60_000);
	expect(queries).toBe(0);
	await trayAction(page, '查詢結果');
	await expect.poll(() => queries).toBe(1);
	await expect(trayRows(page).first()).toContainText('尚未查到完成結果。');
	expect((await pendingItems(page))[0].expiredAt).toBeNull();
	await expect(pendingBadge(page)).toHaveAccessibleName('待確認 1 筆');
});

test('a late month refresh from a lookup does not drop an expense created meanwhile', async ({
	page
}) => {
	const queried = { ...row, id: '33333333-3333-4333-8333-333333333333', note: '查詢午餐' };
	const added = { ...row, id: '44444444-4444-4444-8444-444444444444', note: '新增早餐' };
	const s = await setup(page, async (route, body) => {
		if (!body) {
			await statusJson(route, 'completed', [queried]);
		} else if (s.posts.length === 1) {
			await interrupted(route, body.requestId);
		} else {
			await route.fulfill({ json: { ...created(body.requestId), expenses: [added] } });
		}
	});
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	// Hold the lookup's month refresh with the snapshot taken before the new expense exists.
	let held = 0;
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`${env.PUBLIC_SUPABASE_URL}/rest/v1/expenses?**`, async (route) => {
		// Only the month refresh pages with offset; other list reads pass through.
		const refresh = new URL(route.request().url()).searchParams.has('offset');
		if (route.request().method() === 'GET' && refresh && ++held === 1) {
			await released;
			await route.fulfill({ json: [queried] });
		} else {
			await route.fallback();
		}
	});
	s.setRows([queried]);
	await trayAction(page, '查詢結果');
	await expect.poll(() => held).toBe(1);
	s.setRows([added, queried]);
	await page.getByLabel('記帳內容').fill('早餐50');
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await expect
		.poll(async () => ((await cachedMonth(page, '2026-10')) as { id: string }[] | null) ?? [])
		.toContainEqual(expect.objectContaining({ id: added.id }));
	release();
	await expect(pendingBadge(page)).toHaveCount(0);
	expect(await pending(page)).toBeNull();
	await page
		.getByRole('dialog', { name: 'AI 記帳' })
		.getByRole('button', { name: 'Close', exact: true })
		.click();
	const day = page.locator('section[data-date="2026-10-01"]');
	await expect(day.getByText('新增早餐', { exact: true })).toBeVisible();
	await expect(day.getByText('查詢午餐', { exact: true })).toBeVisible();
	expect(((await cachedMonth(page, '2026-10')) as { id: string }[]).map((r) => r.id)).toEqual(
		expect.arrayContaining([added.id, queried.id])
	);
});
