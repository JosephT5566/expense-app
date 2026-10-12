import { expect, it } from 'vitest';
import { buildSemanticGraph } from '../src/graph';
import { SemanticError } from '../src/errors';
import { raw, request, row } from './fixtures';
import { setup } from './harness';
it('creates via one extraction and one transactional RPC without interruption', async () => {
	const s = setup();
	const result = await buildSemanticGraph(s.deps).invoke({ request, token: 'private-token' });
	expect(result).toMatchObject({
		status: 'created',
		expense: row,
		replayed: false,
		metadata: { inputTokens: null, outputTokens: null }
	});
	expect(s.extractEntry).toHaveBeenCalledTimes(1);
	expect(s.adapter.persistExpense).toHaveBeenCalledTimes(1);
	expect(s.adapter.persistExpense.mock.calls[0]).toMatchObject([
		request.requestId,
		expect.stringMatching(/^[a-f0-9]{64}$/),
		expect.objectContaining({ amount: 851 })
	]);
	expect(JSON.stringify(s.log.mock.calls)).not.toMatch(/private-token|a@example|午餐/);
});
it('rejects invalid extraction without writing', async () => {
	const s = setup();
	s.extractEntry.mockResolvedValue({
		...(await s.extractEntry()),
		raw: { ...raw, amount: null }
	} as never);
	s.extractEntry.mockClear();
	expect(await buildSemanticGraph(s.deps).invoke({ request, token: 't' })).toMatchObject({
		status: 'rejected',
		issues: [{ field: 'amount', code: 'missing' }]
	});
	expect(s.adapter.persistExpense).not.toHaveBeenCalled();
});
it('replays before consuming quota or invoking the model', async () => {
	const s = setup();
	s.adapter.lookupCompleted.mockResolvedValue({ expense: row, replayed: true });
	expect(await buildSemanticGraph(s.deps).invoke({ request, token: 't' })).toMatchObject({
		status: 'created',
		replayed: true,
		metadata: { model: 'replay', inputTokens: null, outputTokens: null }
	});
	expect(s.extractEntry).not.toHaveBeenCalled();
	expect(s.adapter.consumeQuota).not.toHaveBeenCalled();
	expect(s.adapter.persistExpense).not.toHaveBeenCalled();
});
it.each([
	[401, 'unauthorized', 'authenticate'],
	[403, 'forbidden', 'loadContext'],
	[409, 'conflict', 'lookupCompleted']
] as const)('stops on %s before model/write', async (status, code, method) => {
	const s = setup();
	s.adapter[method].mockRejectedValue(new SemanticError(status, code));
	await expect(buildSemanticGraph(s.deps).invoke({ request, token: 't' })).rejects.toMatchObject({
		status
	});
	expect(s.extractEntry).not.toHaveBeenCalled();
	expect(s.adapter.persistExpense).not.toHaveBeenCalled();
});
it('rejects exhausted quota before extraction', async () => {
	const s = setup();
	s.adapter.consumeQuota.mockResolvedValue(false);
	await expect(buildSemanticGraph(s.deps).invoke({ request, token: 't' })).rejects.toMatchObject({
		status: 429
	});
	expect(s.extractEntry).not.toHaveBeenCalled();
	expect(s.adapter.persistExpense).not.toHaveBeenCalled();
});
