import { expect, test, type Page, type Route } from '@playwright/test';
import { loadEnv } from 'vite';
import type { SemanticRequest } from '../packages/semantic-entry-contract/src/index';
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
	handler: (route: Route, body: SemanticRequest | null) => Promise<void>,
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
	const posts: SemanticRequest[] = [];
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
			posts.push(body);
		}
		await handler(route, body);
	});
	await page.goto(`http://localhost:4173${basePath}/`);
	await expect(page.getByRole('status', { name: 'Loading JoPie' })).toHaveCount(0, {
		timeout: 30000
	});
	await page
		.locator('[data-date="2026-10-01"]')
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
	await expect(page.getByRole('button', { name: '圖片分析', exact: true })).toBeDisabled();
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
							expense: row,
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
						expense: row,
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
		expect(route.request().headers().accept).toBe('text/event-stream; semantic-version=2');
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
			const body = route.request().postDataJSON() as SemanticRequest;
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
		const { requestId } = route.request().postDataJSON() as SemanticRequest;
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
		await expect(page.getByText('資訊完整後會直接記帳。', { exact: true })).toBeVisible();
		await submit(page);
		await expect(composer).toBeVisible();
		await expect(composer).toBeDisabled();
		await expect(page.getByText('正在解析，請等待助手回覆。', { exact: true })).toBeVisible();
		release();
		await expect(page.getByLabel('補充資訊')).toBeEditable();
		await expect(composer).toHaveCount(1);
		await expect(
			page.getByText('補充這筆支出的資訊，接續剛才的對話。', { exact: true })
		).toBeVisible();
	} finally {
		release();
	}
});

test('AI dialog defaults to semantic entry and preserves input across mode switches', async ({
	page
}) => {
	await setup(page, async (route, body) => {
		await route.fulfill({ json: created(body!.requestId) });
	});
	await expect(page.getByRole('dialog')).toHaveAccessibleName('文字記帳');
	await expect(page.getByLabel('記帳內容')).toBeVisible();
	await page.getByRole('button', { name: '圖片分析', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveAccessibleName('圖片分析');
	await expect(page.getByLabel('記帳內容')).toBeHidden();
	await expect(page.getByText('上傳收據', { exact: true })).toBeVisible();
	await page.locator('input[type=file][multiple]').setInputFiles({
		name: 'synthetic-receipt.png',
		mimeType: 'image/png',
		buffer: Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',
			'base64'
		)
	});
	await expect(page.getByRole('img', { name: 'Preview', exact: true })).toBeVisible();
	await page.getByRole('button', { name: '文字記帳', exact: true }).click();
	await expect(page.getByLabel('記帳內容')).toHaveValue('午餐100');
	await submit(page);
	await expect(page.getByText('已新增', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: '圖片分析', exact: true }).click();
	await expect(page.getByText('synthetic-receipt.png', { exact: true })).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await page
		.locator('[data-date="2026-10-01"]')
		.getByRole('button', { name: 'AI 記帳', exact: true })
		.click();
	await expect(page.getByLabel('記帳內容')).toBeVisible();
	await expect(page.getByLabel('記帳內容')).toHaveValue('');
});
