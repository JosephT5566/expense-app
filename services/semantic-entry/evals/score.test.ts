import { describe, expect, it, vi } from 'vitest';
import { scoreCase, summarize, type CaseExpectation } from './score';
import { runEvaluation, validateOptions } from './run';
import { context, raw } from '../tests/fixtures';
import { normalizeExtraction } from '../src/normalize';
import cases from './cases.json';
const valid: CaseExpectation = {
	status: 'valid' as const,
	fields: {
		note: '午餐',
		amount: 851,
		currency: 'TWD',
		scope: 'personal',
		category_id: context.otherCategoryId
	}
};
const rejected = {
	status: 'rejected' as const,
	issues: [{ field: 'currency', code: 'unsupported' as const }]
};
describe('evaluation scoring', () => {
	it('compares the same raw output with explicit precision and recall denominators', () => {
		const bad = { ...raw, currency: 'USD' };
		const missing = { ...raw, amount: null };
		const scores = [
			scoreCase(valid, raw, normalizeExtraction(raw, context)),
			scoreCase(rejected, bad, normalizeExtraction(bad, context)),
			scoreCase(valid, missing, normalizeExtraction(missing, context))
		];
		const summary = summarize(scores);
		expect(summary.baseline.precision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
		expect(summary.baseline.recall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
		expect(summary.harness.precision).toEqual({ numerator: 1, denominator: 1, value: 1 });
		expect(summary.harness.recall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
		expect(summary.invalidPayloadBlocked.value).toBe(1);
	});
	it('reports zero eligible precision as N/A and unknown usage as null', () => {
		const score = scoreCase(
			rejected,
			{ ...raw, amount: null, currency: 'USD' },
			normalizeExtraction({ ...raw, amount: null, currency: 'USD' }, context)
		);
		expect(summarize([score]).baseline.precision.value).toBeNull();
		expect(summarize([score]).usage.inputTokens).toBeNull();
		expect(summarize([score]).usage.outputTokens).toBeNull();
	});
	it('does not count provider failure as a correct semantic rejection', () => {
		const score = {
			...scoreCase(rejected, null, { status: 'rejected', issues: [] }),
			error: 'provider_error'
		};
		expect(summarize([score]).rejectionCorrect.denominator).toBe(0);
		expect(summarize([score]).failures).toBe(1);
	});
});
describe('bounded fixture evaluation', () => {
	it('rejects more than 120 calls before contacting a provider', () => {
		expect(() => validateOptions({ mode: 'live', runs: 4, maxCalls: 120 }, 40)).toThrow();
		expect(() => validateOptions({ mode: 'live', runs: 3, maxCalls: 121 }, 40)).toThrow();
		expect(() => validateOptions({ mode: 'bad', runs: 1, maxCalls: 120 }, 40)).toThrow();
	});
	it('has 40 unique synthetic cases, five in each of eight groups', () => {
		expect(cases).toHaveLength(40);
		expect(new Set(cases.map((c) => c.id)).size).toBe(40);
		const groups = new Map<string, number>();
		for (const item of cases) {
			groups.set(item.group, (groups.get(item.group) ?? 0) + 1);
		}
		const counts = [...groups.values()];
		expect(counts).toEqual(Array(8).fill(5));
	});
	it('runs fixtures without consulting a live provider or persisting', async () => {
		const provider = vi.fn(() => {
			throw Error('network must not run');
		});
		const result = await runEvaluation(
			{ mode: 'fixture', runs: 3, maxCalls: 120 },
			cases,
			provider
		);
		expect(result.observations).toHaveLength(120);
		expect(result.paidCalls).toBe(0);
		expect(provider).not.toHaveBeenCalled();
		expect(result.summary.harness.precision.value).toBe(1);
		expect(result.summary.harness.recall.value).toBe(1);
		expect(result.summary.rejectionCorrect.value).toBe(1);
	});
});
it('estimates cost only with known usage and recorded nonnegative pricing', async () => {
	const { estimateCost } = await import('./score');
	expect(
		estimateCost(
			{ inputTokens: 1000, outputTokens: 500 },
			{ inputUsdPerMillion: 2, outputUsdPerMillion: 8 }
		)
	).toBe(0.006);
	expect(
		estimateCost(
			{ inputTokens: null, outputTokens: 500 },
			{ inputUsdPerMillion: 2, outputUsdPerMillion: 8 }
		)
	).toBeNull();
	expect(
		estimateCost(
			{ inputTokens: 1000, outputTokens: 500 },
			{ inputUsdPerMillion: null, outputUsdPerMillion: null }
		)
	).toBeNull();
	expect(() =>
		estimateCost(
			{ inputTokens: 1000, outputTokens: 500 },
			{ inputUsdPerMillion: -1, outputUsdPerMillion: 8 }
		)
	).toThrow();
});
