import { afterEach, expect, it, vi } from 'vitest';
import { handleSemanticRequest } from '../src/handler';
import { SemanticError } from '../src/errors';
import { setup } from './harness';
import { request, row } from './fixtures';
const post = (body: unknown = request, token = true) =>
	new Request('http://localhost/semantic-entry', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: 'Bearer synthetic' } : {})
		},
		body: JSON.stringify(body)
	});
afterEach(() => vi.useRealTimers());
it('requires a token before reading authenticated context', async () => {
	const s = setup();
	expect((await handleSemanticRequest(post(request, false), s.deps)).status).toBe(401);
	expect(s.adapter.authenticate).not.toHaveBeenCalled();
});
it.each([
	{ ...request, userId: 'a' },
	{ ...request, hash: 'x' },
	{ ...request, text: 'a'.repeat(9000) }
])('rejects invalid/oversized HTTP requests without model/write', async (body) => {
	const s = setup();
	expect((await handleSemanticRequest(post(body), s.deps)).status).toBe(400);
	expect(s.extractEntry).not.toHaveBeenCalled();
	expect(s.adapter.persistExpense).not.toHaveBeenCalled();
});
it('returns a terminal 422 rejection', async () => {
	const s = setup();
	s.extractEntry.mockResolvedValue({
		raw: {},
		model: 'synthetic',
		inputTokens: null,
		outputTokens: null
	} as never);
	const response = await handleSemanticRequest(post(), s.deps);
	expect(response.status).toBe(422);
	expect((await response.json()).status).toBe('rejected');
	expect(s.adapter.persistExpense).not.toHaveBeenCalled();
});
it('returns unknown completion after a persistence timeout', async () => {
	vi.useFakeTimers();
	const s = setup();
	s.adapter.persistExpense.mockImplementation(() => new Promise(() => {}));
	const pending = handleSemanticRequest(post(), { ...s.deps, httpDeadlineMs: 30000 });
	await vi.advanceTimersByTimeAsync(30001);
	const response = await pending;
	expect(response.status).toBe(504);
	expect(await response.json()).toMatchObject({
		error: { code: 'persist_uncertain', uncertain: true }
	});
});
it('returns GET not_found without invoking model/quota/write', async () => {
	const s = setup();
	const response = await handleSemanticRequest(
		new Request(`http://localhost/semantic-entry/${request.requestId}`, {
			headers: { Authorization: 'Bearer b' }
		}),
		s.deps
	);
	expect(await response.json()).toEqual({ status: 'not_found', requestId: request.requestId });
	expect(s.extractEntry).not.toHaveBeenCalled();
	expect(s.adapter.consumeQuota).not.toHaveBeenCalled();
});
it('returns completed GET snapshots and preserves authentication isolation', async () => {
	const s = setup();
	s.adapter.lookupCompleted.mockResolvedValue({ expense: row, replayed: true });
	const get = () =>
		new Request(`http://localhost/semantic-entry/${request.requestId}`, {
			headers: { Authorization: 'Bearer a' }
		});
	expect(await (await handleSemanticRequest(get(), s.deps)).json()).toMatchObject({
		status: 'completed',
		expense: row
	});
	s.adapter.authenticate.mockRejectedValue(new SemanticError(401, 'unauthorized'));
	expect((await handleSemanticRequest(get(), s.deps)).status).toBe(401);
});
it('allows only configured CORS origins', async () => {
	const s = setup();
	const options = (origin: string) =>
		new Request('http://localhost/semantic-entry', {
			method: 'OPTIONS',
			headers: { Origin: origin }
		});
	expect(
		(
			await handleSemanticRequest(options('https://evil.test'), {
				...s.deps,
				allowedOrigins: ['https://app.test']
			})
		).status
	).toBe(403);
	const response = await handleSemanticRequest(options('https://app.test'), {
		...s.deps,
		allowedOrigins: ['https://app.test']
	});
	expect(response.status).toBe(204);
	expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.test');
});
