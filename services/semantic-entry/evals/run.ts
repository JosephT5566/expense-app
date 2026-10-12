import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SemanticContext, ValidationResult } from '@jopie/semantic-entry-contract';
import type { ExtractionResult } from '../src/graph';
import { normalizeExtraction } from '../src/normalize';
import { PROMPT_VERSION } from '../src/prompt';
import { scoreCase, summarize, estimateCost, type CaseExpectation } from './score';
export interface Options {
	mode: string;
	runs: number;
	maxCalls: number;
}
interface EvaluationCase {
	id: string;
	group: string;
	text: string;
	context: SemanticContext;
	raw: unknown;
	expected: CaseExpectation;
}
type Provider = (
	text: string,
	context: SemanticContext,
	signal: AbortSignal
) => Promise<ExtractionResult>;
export function validateOptions(options: Options, count: number) {
	if (
		!['fixture', 'live'].includes(options.mode) ||
		!Number.isSafeInteger(options.runs) ||
		options.runs < 1 ||
		!Number.isSafeInteger(options.maxCalls) ||
		options.maxCalls < 1 ||
		options.maxCalls > 120 ||
		count * options.runs > options.maxCalls
	) {
		throw Error('Evaluation requires fixture/live mode and at most 120 observations/calls');
	}
}
export async function runEvaluation(options: Options, input: unknown[], provider?: Provider) {
	validateOptions(options, input.length);
	const cases = input as EvaluationCase[];
	if (
		new Set(cases.map((c) => c.id)).size !== cases.length ||
		cases.some(
			(c) =>
				!c.id ||
				!c.text ||
				!c.context ||
				!['valid', 'rejected'].includes(c.expected?.status)
		)
	) {
		throw Error('Invalid evaluation cases');
	}
	if (options.mode === 'live' && !provider) {
		throw Error('Live provider required');
	}
	const observations = [];
	let paidCalls = 0;
	for (const item of cases) {
		for (let run = 1; run <= options.runs; run++) {
			const start = performance.now();
			let raw = item.raw;
			let extracted: ExtractionResult | undefined;
			let error: string | undefined;
			let result: ValidationResult;
			try {
				if (options.mode === 'live') {
					paidCalls++;
					extracted = await provider!(
						item.text,
						item.context,
						new AbortController().signal
					);
					raw = extracted.raw;
				}
				result = normalizeExtraction(raw, item.context);
			} catch {
				error = 'provider_error';
				raw = null;
				result = { status: 'rejected', issues: [] };
			}
			const score = {
				...scoreCase(item.expected, raw, result),
				inputTokens: extracted?.inputTokens ?? null,
				outputTokens: extracted?.outputTokens ?? null,
				elapsedMs: performance.now() - start,
				...(error ? { error } : {})
			};
			observations.push({ id: item.id, group: item.group, run, raw, result, score });
		}
	}
	return { observations, paidCalls, summary: summarize(observations.map((o) => o.score)) };
}
async function main() {
	const args = process.argv.slice(2);
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		if (
			!['--mode', '--runs', '--max-calls', '--out'].includes(args[i]) ||
			!args[i + 1] ||
			values.has(args[i])
		) {
			throw Error('Invalid CLI arguments');
		}
		values.set(args[i], args[i + 1]);
	}
	const options = {
		mode: values.get('--mode') ?? 'fixture',
		runs: Number(values.get('--runs') ?? 3),
		maxCalls: Number(values.get('--max-calls') ?? 120)
	};
	const here = dirname(fileURLToPath(import.meta.url));
	const caseText = await readFile(resolve(here, 'cases.json'), 'utf8');
	const cases = JSON.parse(caseText) as unknown[];
	validateOptions(options, cases.length);
	const price = (name: string) => (process.env[name] ? Number(process.env[name]) : null);
	const pricing = {
		inputUsdPerMillion: price('SEMANTIC_INPUT_USD_PER_MILLION'),
		outputUsdPerMillion: price('SEMANTIC_OUTPUT_USD_PER_MILLION'),
		source: process.env.SEMANTIC_PRICING_SOURCE ?? null,
		asOf: process.env.SEMANTIC_PRICING_AS_OF ?? null
	};
	if (
		(pricing.inputUsdPerMillion !== null || pricing.outputUsdPerMillion !== null) &&
		(!pricing.source || !pricing.asOf)
	) {
		throw Error('Record pricing source and date');
	}
	estimateCost({ inputTokens: null, outputTokens: null }, pricing);
	let provider: Provider | undefined;
	if (options.mode === 'live') {
		const { createProvider } = await import('../src/provider');
		if (!process.env.OPENAI_API_KEY) {
			throw Error('Live evaluation requires OPENAI_API_KEY');
		}
		provider = createProvider({
			apiKey: process.env.OPENAI_API_KEY,
			model: process.env.SEMANTIC_MODEL
		});
	}
	const result = await runEvaluation(options, cases, provider);
	const packageJson = JSON.parse(await readFile(resolve(here, '../package.json'), 'utf8'));
	const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
	const estimatedCostUsd = estimateCost(result.summary.usage, pricing);
	const manifest = {
		...options,
		gitSha: sha,
		caseHash: createHash('sha256').update(caseText).digest('hex'),
		date: new Date().toISOString(),
		node: process.version,
		versions: packageJson.dependencies,
		promptVersion: PROMPT_VERSION,
		model: options.mode === 'live' ? (process.env.SEMANTIC_MODEL ?? 'gpt-5.4-mini') : 'fixture',
		paidCalls: result.paidCalls,
		pricing,
		estimatedCostUsd,
		costNote:
			'Recorded pricing assumptions only; unknown usage or price stays null. Estimates are not bills.',
		methodology:
			'Model-only baseline: nonempty note and positive finite numeric amount; no rule gate. Both projections share the same raw output and five common fields. Derived fields are harness-only. Provider failures excluded from quality denominators, reported separately. Fixture runs do not measure model quality.'
	};
	const out = resolve(
		values.get('--out') ?? resolve(here, 'runs', manifest.date.replaceAll(':', '-'))
	);
	await mkdir(out, { recursive: true });
	await Promise.all([
		writeFile(
			resolve(out, 'observations.json'),
			JSON.stringify(result.observations, null, 2) + '\n'
		),
		writeFile(resolve(out, 'summary.json'), JSON.stringify(result.summary, null, 2) + '\n'),
		writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
	]);
	process.stdout.write(
		JSON.stringify({
			out,
			caseIds: cases.length,
			observations: result.observations.length,
			paidCalls: result.paidCalls,
			failures: result.summary.failures
		}) + '\n'
	);
	if (result.summary.failures) {
		process.exitCode = 1;
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => {
		process.stderr.write('Evaluation failed; verify arguments and configuration.\n');
		process.exitCode = 1;
	});
}
