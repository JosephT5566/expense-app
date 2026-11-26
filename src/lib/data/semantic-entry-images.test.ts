import { afterEach, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_SEMANTIC_ENTRY_URL: 'https://semantic.example.test' }
}));
vi.mock('$lib/supabase/supabaseClient', () => ({
	supabase: {
		auth: {
			getSession: vi.fn(async () => ({
				data: { session: { access_token: 'synthetic' } },
				error: null
			}))
		}
	}
}));
import { requestImageUrls, restoredImageUrls } from './semantic-entry.fetcher';
const path = (n: number) => `uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${n}.png`;
const target = (path: string) => ({
	path,
	url: `https://images.example.test/${path}`,
	expiresAt: '2026-10-01T04:15:00Z'
});
afterEach(() => vi.unstubAllGlobals());

it('signs unique paths in batches of four with auth and exact JSON, without reading image bytes', async () => {
	const batches: string[][] = [];
	const fetch = vi.fn(async (url: URL, options: RequestInit) => {
		expect(String(url)).toBe('https://semantic.example.test/semantic-entry/uploads/urls');
		expect(options.method).toBe('POST');
		expect(options.headers).toMatchObject({
			Authorization: 'Bearer synthetic',
			Accept: 'application/json'
		});
		const body = JSON.parse(String(options.body));
		expect(Object.keys(body)).toEqual(['paths']);
		batches.push(body.paths);
		return Response.json({ images: body.paths.map(target) });
	});
	vi.stubGlobal('fetch', fetch);
	const images = await restoredImageUrls([
		path(0),
		path(0),
		...Array.from({ length: 5 }, (_, n) => path(n + 1))
	]);
	expect(batches.map((batch) => batch.length)).toEqual([4, 2]);
	expect(images.size).toBe(6);
	expect(fetch).toHaveBeenCalledTimes(2);
});
it('recovers surviving images individually after a batch image_not_found', async () => {
	const batches: string[][] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: URL, options: RequestInit) => {
			const { paths } = JSON.parse(String(options.body));
			batches.push(paths);
			return paths.includes(path(1))
				? Response.json({ error: { code: 'image_not_found' } }, { status: 404 })
				: Response.json({ images: paths.map(target) });
		})
	);
	const images = await restoredImageUrls([path(0), path(1), path(2)]);
	expect([...images.keys()]).toEqual([path(0), path(2)]);
	expect(batches).toEqual([[path(0), path(1), path(2)], [path(0)], [path(1)], [path(2)]]);
});
it.each(['image_forbidden_path', 'origin_forbidden'])(
	'does not retry forbidden batches: %s',
	async (code) => {
		const fetch = vi.fn(async () => Response.json({ error: { code } }, { status: 403 }));
		vi.stubGlobal('fetch', fetch);
		expect((await restoredImageUrls([path(0), path(1)])).size).toBe(0);
		expect(fetch).toHaveBeenCalledTimes(1);
	}
);
it.each(['http://images.example.test/image', 'javascript:alert(1)'])(
	'rejects unsafe signed URL %s',
	async (url) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ images: [{ ...target(path(0)), url }] }))
		);
		await expect(requestImageUrls([path(0)])).rejects.toMatchObject({
			code: 'invalid_response'
		});
	}
);
it('rejects response path mismatch and invalid request paths', async () => {
	const fetch = vi.fn(async () => Response.json({ images: [target(path(1))] }));
	vi.stubGlobal('fetch', fetch);
	await expect(requestImageUrls([path(0)])).rejects.toMatchObject({ code: 'invalid_response' });
	await expect(requestImageUrls([])).rejects.toMatchObject({ code: 'invalid_request' });
	await expect(requestImageUrls([path(0), path(0)])).rejects.toMatchObject({
		code: 'invalid_request'
	});
});
it('maps an aborted signing request to a settled placeholder result', async () => {
	const controller = new AbortController();
	controller.abort();
	vi.stubGlobal('fetch', vi.fn());
	expect((await restoredImageUrls([path(0)], controller.signal)).size).toBe(0);
	expect(fetch).not.toHaveBeenCalled();
});
