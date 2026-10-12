import { isDeepStrictEqual } from 'node:util';
import type { Issue, ValidatedExpense, ValidationResult } from '@jopie/semantic-entry-contract';
export type CaseExpectation =
	| { status: 'valid'; fields: Partial<ValidatedExpense> }
	| { status: 'rejected'; issues: Issue[] };
export interface CaseScore {
	expectedEligible: boolean;
	baselineEligible: boolean;
	harnessEligible: boolean;
	baselineFields: number;
	harnessFields: number;
	commonFields: number;
	derivedFields: number;
	derivedTotal: number;
	rejectionCorrect: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	elapsedMs: number | null;
	error?: string;
}
const common = ['note', 'amount', 'currency', 'scope', 'category_id'] as const;
const derived = ['ts', 'payer_email', 'shares_json', 'is_settled'] as const;
export function scoreCase(
	expected: CaseExpectation,
	raw: unknown,
	result: ValidationResult
): CaseScore {
	const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const baselineEligible =
		typeof r.note === 'string' &&
		!!r.note.trim() &&
		typeof r.amount === 'number' &&
		Number.isFinite(r.amount) &&
		r.amount > 0;
	const proposal: Record<string, unknown> = { ...r, category_id: r.categoryId };
	const actual = result.status === 'valid' ? result.expense : ({} as Partial<ValidatedExpense>);
	const fields = expected.status === 'valid' ? expected.fields : {};
	const commonKeys = common.filter((k) => k in fields);
	const derivedKeys = derived.filter((k) => k in fields);
	const issues = (values: Issue[]) => values.map((v) => `${v.field}:${v.code}`).sort();
	return {
		expectedEligible: expected.status === 'valid',
		baselineEligible,
		harnessEligible: result.status === 'valid',
		baselineFields: commonKeys.filter((k) => isDeepStrictEqual(proposal[k], fields[k])).length,
		harnessFields: commonKeys.filter((k) => isDeepStrictEqual(actual[k], fields[k])).length,
		commonFields: commonKeys.length,
		derivedFields: derivedKeys.filter((k) => isDeepStrictEqual(actual[k], fields[k])).length,
		derivedTotal: derivedKeys.length,
		rejectionCorrect:
			expected.status === 'rejected' &&
			result.status === 'rejected' &&
			isDeepStrictEqual(issues(expected.issues), issues(result.issues)),
		inputTokens: null,
		outputTokens: null,
		elapsedMs: null
	};
}
const metric = (numerator: number, denominator: number) => ({
	numerator,
	denominator,
	value: denominator ? numerator / denominator : null
});
export function summarize(scores: CaseScore[]) {
	const quality = scores.filter((s) => !s.error);
	const eligible = quality.filter((s) => s.expectedEligible).length;
	const evaluate = (
		key: 'baselineEligible' | 'harnessEligible',
		field: 'baselineFields' | 'harnessFields'
	) => {
		const predicted = quality.filter((s) => s[key]);
		const tp = predicted.filter((s) => s.expectedEligible).length;
		return {
			precision: metric(tp, predicted.length),
			recall: metric(tp, eligible),
			fieldAccuracy: metric(
				quality.reduce((n, s) => n + s[field], 0),
				quality.reduce((n, s) => n + s.commonFields, 0)
			)
		};
	};
	const rejected = quality.filter((s) => !s.expectedEligible);
	const invalid = rejected.filter((s) => s.baselineEligible);
	const usage = (key: 'inputTokens' | 'outputTokens') =>
		scores.every((s) => s[key] !== null) ? scores.reduce((n, s) => n + s[key]!, 0) : null;
	const times = scores
		.flatMap((s) => (s.elapsedMs === null ? [] : [s.elapsedMs]))
		.sort((a, b) => a - b);
	const percentile = (p: number) =>
		times.length ? times[Math.max(0, Math.ceil(p * times.length) - 1)] : null;
	return {
		observations: scores.length,
		qualityObservations: quality.length,
		failures: scores.length - quality.length,
		baseline: evaluate('baselineEligible', 'baselineFields'),
		harness: evaluate('harnessEligible', 'harnessFields'),
		derivedFieldAccuracy: metric(
			quality.reduce((n, s) => n + s.derivedFields, 0),
			quality.reduce((n, s) => n + s.derivedTotal, 0)
		),
		rejectionCorrect: metric(
			rejected.filter((s) => s.rejectionCorrect).length,
			rejected.length
		),
		invalidPayloadBlocked: metric(
			invalid.filter((s) => !s.harnessEligible).length,
			invalid.length
		),
		usage: {
			inputTokens: usage('inputTokens'),
			outputTokens: usage('outputTokens'),
			knownInputObservations: scores.filter((s) => s.inputTokens !== null).length,
			knownOutputObservations: scores.filter((s) => s.outputTokens !== null).length
		},
		latency: { samples: times.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }
	};
}
export type EvaluationSummary = ReturnType<typeof summarize>;
export interface Pricing {
	inputUsdPerMillion: number | null;
	outputUsdPerMillion: number | null;
}
export function estimateCost(
	usage: { inputTokens: number | null; outputTokens: number | null },
	pricing: Pricing
): number | null {
	for (const value of [pricing.inputUsdPerMillion, pricing.outputUsdPerMillion]) {
		if (value !== null && (!Number.isFinite(value) || value < 0)) {
			throw Error('Invalid pricing');
		}
	}
	if (
		usage.inputTokens === null ||
		usage.outputTokens === null ||
		pricing.inputUsdPerMillion === null ||
		pricing.outputUsdPerMillion === null
	) {
		return null;
	}
	return (
		(usage.inputTokens * pricing.inputUsdPerMillion +
			usage.outputTokens * pricing.outputUsdPerMillion) /
		1000000
	);
}
