import { afterEach, expect, it, vi } from 'vitest';
import { createProvider } from '../src/provider';
import { context, raw } from './fixtures';
afterEach(() => vi.useRealTimers());
const completed = {
	status: 'completed',
	output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(raw) }] }]
};
it('sends one strict structured call with an 800-token cap and no reasoning', async () => {
	const fetcher = vi.fn(async () => Response.json(completed));
	const result = await createProvider({
		apiKey: 'synthetic',
		model: 'gpt-5.4-mini',
		fetch: fetcher
	})('午餐851', context, new AbortController().signal);
	const body = JSON.parse(
		String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)
	);
	expect(body).toMatchObject({
		max_output_tokens: 800,
		reasoning: { effort: 'none' },
		store: false,
		text: {
			format: { type: 'json_schema', strict: true, schema: { additionalProperties: false } }
		}
	});
	expect(body.tools).toBeUndefined();
	expect(result).toMatchObject({ raw, inputTokens: null, outputTokens: null });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
	{ status: 'incomplete', output: [] },
	{
		status: 'completed',
		output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }]
	},
	{
		status: 'completed',
		output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }]
	}
])('rejects refusal/incomplete/invalid output without retries', async (payload) => {
	const fetcher = vi.fn(async () => Response.json(payload));
	await expect(
		createProvider({ apiKey: 'synthetic', fetch: fetcher })(
			'test',
			context,
			new AbortController().signal
		)
	).rejects.toMatchObject({ status: 502 });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
it('times out at fifteen seconds without retries even if fetch ignores abort', async () => {
	vi.useFakeTimers();
	const fetcher = vi.fn(() => new Promise<Response>(() => {}));
	const pending = createProvider({ apiKey: 'synthetic', fetch: fetcher })(
		'test',
		context,
		new AbortController().signal
	);
	const assertion = expect(pending).rejects.toMatchObject({ status: 504 });
	await vi.advanceTimersByTimeAsync(15001);
	await assertion;
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects syntactically valid but schema-invalid provider JSON', async () => {
	const fetcher = vi.fn(async () =>
		Response.json({
			status: 'completed',
			output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }]
		})
	);
	await expect(
		createProvider({ apiKey: 'synthetic', fetch: fetcher })(
			'test',
			context,
			new AbortController().signal
		)
	).rejects.toMatchObject({ status: 502 });
});
