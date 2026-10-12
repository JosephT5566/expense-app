import type { SemanticContext } from '@jopie/semantic-entry-contract';
import type { ExtractionResult } from './graph';
import { parseExtraction } from './normalize';
import { SemanticError } from './errors';
import { extractionSchema, systemPrompt } from './prompt';
export function createProvider(config: { apiKey: string; model?: string; fetch?: typeof fetch }) {
	return async (
		text: string,
		ctx: SemanticContext,
		signal: AbortSignal
	): Promise<ExtractionResult> => {
		const model = config.model ?? 'gpt-5.4-mini';
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new SemanticError(504, 'provider_timeout'));
			}, 15000);
		});
		try {
			if (!config.apiKey) {
				throw new SemanticError(502, 'provider_configuration');
			}
			const response = await Promise.race([
				(config.fetch ?? fetch)('https://api.openai.com/v1/responses', {
					method: 'POST',
					signal: combined,
					headers: {
						Authorization: `Bearer ${config.apiKey}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						model,
						store: false,
						max_output_tokens: 800,
						reasoning: { effort: 'none' },
						input: [
							{ role: 'system', content: systemPrompt(ctx) },
							{ role: 'user', content: text }
						],
						text: {
							format: {
								type: 'json_schema',
								name: 'semantic_expense',
								strict: true,
								schema: extractionSchema
							}
						}
					})
				}),
				timeout
			]);
			if (!response.ok) {
				throw new SemanticError(502, 'provider_error');
			}
			const data = await Promise.race([response.json(), timeout]);
			if (data.status !== 'completed' || !Array.isArray(data.output)) {
				throw new SemanticError(502, 'provider_invalid');
			}
			const content = data.output.flatMap(
				(item: { content?: unknown[] }) => item.content ?? []
			);
			if (content.some((item: { type?: string }) => item.type === 'refusal')) {
				throw new SemanticError(502, 'provider_refusal');
			}
			const texts = content.filter((item: { type?: string }) => item.type === 'output_text');
			if (texts.length !== 1 || typeof texts[0].text !== 'string') {
				throw new SemanticError(502, 'provider_invalid');
			}
			let raw: unknown;
			try {
				raw = parseExtraction(JSON.parse(texts[0].text));
			} catch {
				throw new SemanticError(502, 'provider_invalid');
			}
			const tokens = (v: unknown) =>
				typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
			return {
				raw,
				model,
				inputTokens: tokens(data.usage?.input_tokens),
				outputTokens: tokens(data.usage?.output_tokens)
			};
		} catch (error) {
			if (error instanceof SemanticError) {
				throw error;
			}
			if (combined.aborted) {
				throw new SemanticError(504, 'provider_timeout');
			}
			throw new SemanticError(502, 'provider_error');
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	};
}
