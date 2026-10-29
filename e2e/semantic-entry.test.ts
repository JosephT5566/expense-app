import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
	draftIssues,
	effectiveDrafts,
	fromServerDrafts,
	isComplete,
	toClientDraft
} from '../src/lib/components/semantic-entry/drafts';
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
	allowedEmails = [user.email, 'b@example.test']
) {
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (['localhost', '127.0.0.1'].includes(url.hostname)) {
			await route.continue();
		} else {
			await route.abort();
		}
	});
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
const submit = (page: Page) => page.getByRole('button', { name: '送出記帳', exact: true }).click();
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
						: { status: 'completed', requestId, expenses: [row], replayed: true }
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
					await route.abort();
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
		await page.getByRole('button', { name: '重試同一請求' }).click();
		await expect.poll(() => s.posts.length).toBe(2);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: '修改後重新送出' })).toHaveCount(0);
		expect(s.posts[1]).toEqual(s.posts[0]);
		await page.getByRole('button', { name: '查詢結果' }).click();
		await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	});
}
for (const lifecycle of ['reload', 'navigate']) {
	test(`pending request survives ${lifecycle} with UUID only and status lookup`, async ({
		page
	}) => {
		const s = await setup(page, async (route, body) => {
			if (body) {
				await route.abort();
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
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await expect(page.getByLabel('記帳內容')).toHaveValue('');
		await expect(page.getByLabel('記帳內容')).toBeDisabled();
		await expect(page.getByRole('button', { name: '重試同一請求' })).toHaveCount(0);
		await page.getByRole('button', { name: '查詢結果' }).click();
		await expect(page.getByText('已新增', { exact: true })).toBeVisible();
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
	const s = await setup(page, async (route) => route.abort());
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
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
	await switchAccount(false);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await expect(page.getByLabel('記帳內容')).toHaveValue('');
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
test('interrupted stream retains only UUID and retry freezes the full answered payload', async ({
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
	expect(stored).toEqual({ requestId: s.posts[1].requestId });
	await page.getByRole('button', { name: '重試同一請求' }).click();
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
	test(`SSE ${fault} preserves uncertain recovery without applying expense data`, async ({
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
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await expect(page.getByText('已新增', { exact: true })).toHaveCount(0);
		expect(s.writes()).toBe(0);
	});
}

for (const fault of ['gap', 'duplicate', 'wrong-id', 'oversize', 'after-writing']) {
	test(`analysis ${fault} keeps uncertain recovery`, async ({ page }) => {
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
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
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
				body: `event: analysis_delta\ndata: ${JSON.stringify({ requestId: body.requestId, seq: 0, text: '本帳號的暫時摘要' })}\n\n`
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
			await page.getByRole('button', { name: '查詢結果', exact: true }).click();
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
			await route.fulfill({ contentType: 'text/event-stream', body: result + trailing });
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
				await route.abort();
			} else {
				await route.fulfill({ json: created(body!.requestId) });
			}
		});
		await page.clock.setFixedTime(new Date('2026-10-01T23:59:00+08:00'));
		await submit(page);
		await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
		await page.clock.setFixedTime(new Date('2026-10-02T00:01:00+08:00'));
		await page.getByRole('button', { name: '重試同一請求' }).click();
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
			await route.abort();
		} else {
			await route.fulfill({ json: created(body!.requestId) });
		}
	});
	const uploads = await mockUploads(page);
	await attach(page);
	await submit(page);
	await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '附加圖片', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: '重試同一請求' }).click();
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
	await page.evaluate(() => {
		const original = AbortSignal.timeout;
		AbortSignal.timeout = (ms) => original(ms === 32000 ? 50 : ms);
	});
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
	test(`commit timeout ${action} preserves recovery and never writes expenses directly`, async ({
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
			}
		});
		await startDrafts(page);
		await shortenTimeout(page);
		await commitDrafts(page).click();
		await expect(page.getByText('無法確認是否已記帳', { exact: true })).toBeVisible();
		await expect(page.getByRole('dialog').locator('textarea')).toBeDisabled();
		await expect(commitDrafts(page)).toBeDisabled();
		await expect(page.getByRole('button', { name: '進入編輯', exact: true })).toBeDisabled();
		expect(JSON.parse((await pending(page))!).requestId).toBe(s.posts[1].requestId);
		s.setRows(batchRows);
		const before = expenseReads;
		if (action === 'retry') {
			await page.getByRole('button', { name: '重新確認', exact: true }).click();
			await expect(page.getByRole('group', { name: '已記帳摘要' })).toContainText(
				'已記帳 3 筆'
			);
			expect(s.posts[2]).toEqual(s.posts[1]);
			expect(expenseReads).toBeGreaterThan(before);
			expect(await pending(page)).toBeNull();
		} else {
			await page.getByRole('button', { name: '稍後再看', exact: true }).click();
			await expect(page.getByRole('dialog')).toHaveCount(0);
			expect(JSON.parse((await pending(page))!).requestId).toBe(s.posts[1].requestId);
			await page
				.locator('section[data-date="2026-10-01"]')
				.getByRole('button', { name: 'AI 記帳', exact: true })
				.click();
			await expect(page.getByText('結果待確認', { exact: true })).toBeVisible();
			await expect(draftBlock(page)).toHaveCount(0);
			await page.getByRole('button', { name: '查詢結果', exact: true }).click();
			await expect(page.getByRole('group', { name: '已記帳摘要' })).toContainText(
				'已記帳 3 筆'
			);
			expect(expenseReads).toBeGreaterThan(before);
			expect(await pending(page)).toBeNull();
		}
		expect(s.writes()).toBe(0);
	});
}

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
