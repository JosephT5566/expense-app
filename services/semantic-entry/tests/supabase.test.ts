import { expect, it, vi } from 'vitest';
import { createSupabaseAdapter } from '../src/supabase';
import { requestId, row } from './fixtures';
it('uses the caller JWT for auth, context, and owner-filtered status lookup', async () => {
	const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-caller');
		const url = String(input);
		if (url.includes('/auth/v1/user')) {
			return Response.json({ id: 'a', email: 'a@example.test' });
		}
		if (url.includes('app_settings')) {
			return Response.json({ allowed_emails: ['a@example.test', 'b@example.test'] });
		}
		if (url.includes('categories')) {
			return Response.json([{ id: 'other', name: '其他', kind: 'expense' }]);
		}
		return Response.json({ user_id: 'a', input_hash: 'a'.repeat(64), result: row });
	});
	const adapter = createSupabaseAdapter(
		{
			url: 'https://synthetic.test',
			publishableKey: 'synthetic-public',
			memberNames: { 'a@example.test': '甲', 'b@example.test': '乙' },
			otherCategoryId: 'other',
			fetch: fetcher
		},
		'synthetic-caller',
		new AbortController().signal
	);
	const user = await adapter.authenticate();
	expect((await adapter.loadContext(user)).members).toHaveLength(2);
	expect(await adapter.lookupCompleted(requestId, 'a'.repeat(64))).toEqual({
		expense: row,
		replayed: true
	});
	expect(fetcher.mock.calls.some(([url]) => String(url).includes('user_id=eq.a'))).toBe(true);
	await expect(adapter.lookupCompleted(requestId, 'b'.repeat(64))).rejects.toMatchObject({
		status: 409
	});
});
