import { createHash } from 'node:crypto';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { parseRequest } from '@jopie/semantic-entry-contract';
import { normalizeExtraction } from './normalize';
import { PROMPT_VERSION } from './prompt';
import { SemanticError } from './errors';
import type {
	CompletedResult,
	SemanticContext,
	SemanticRequest,
	SemanticResponse,
	ValidatedExpense
} from '@jopie/semantic-entry-contract';
export interface VerifiedUser {
	id: string;
	email: string;
}
export interface Adapter {
	authenticate(): Promise<VerifiedUser>;
	loadContext(user: VerifiedUser): Promise<SemanticContext>;
	lookupCompleted(requestId: string, inputHash?: string): Promise<CompletedResult | null>;
	consumeQuota(): Promise<boolean>;
	persistExpense(
		requestId: string,
		inputHash: string,
		expense: ValidatedExpense
	): Promise<CompletedResult>;
}
export interface ExtractionResult {
	raw: unknown;
	model: string;
	inputTokens: number | null;
	outputTokens: number | null;
}
export interface GraphDependencies {
	createAdapter(token: string, signal: AbortSignal): Adapter;
	extractEntry(
		text: string,
		ctx: SemanticContext,
		signal: AbortSignal
	): Promise<ExtractionResult>;
	log?(event: Record<string, unknown>): void;
}

const State = Annotation.Root({
	user: Annotation<VerifiedUser>(),
	context: Annotation<SemanticContext>(),
	extraction: Annotation<ExtractionResult>(),
	validation: Annotation<ReturnType<typeof normalizeExtraction>>(),
	result: Annotation<SemanticResponse>()
});
export function buildSemanticGraph(deps: GraphDependencies) {
	return {
		invoke: async (input: {
			request: SemanticRequest;
			token: string;
			signal?: AbortSignal;
		}): Promise<SemanticResponse> => {
			const request = parseRequest(input.request);
			const signal = input.signal ?? new AbortController().signal;
			const adapter = deps.createAdapter(input.token, signal);
			const start = Date.now();
			const hash = createHash('sha256').update(`v1\n${request.text}`).digest('hex');
			const guard = () => signal.throwIfAborted();
			const log = (node: string, status: string) => {
				try {
					deps.log?.({
						requestId: request.requestId,
						node,
						status,
						elapsedMs: Date.now() - start
					});
				} catch {
					/* logging cannot alter accepted writes */
				}
			};
			const metadata = (e?: ExtractionResult) => ({
				model: e?.model ?? 'replay',
				promptVersion: PROMPT_VERSION,
				inputTokens: e?.inputTokens ?? null,
				outputTokens: e?.outputTokens ?? null,
				elapsedMs: Date.now() - start
			});
			const graph = new StateGraph(State)
				.addNode('authenticate', async () => {
					guard();
					const user = await adapter.authenticate();
					log('authenticate', 'ok');
					return { user };
				})
				.addNode('load_context', async (s) => {
					guard();
					return { context: await adapter.loadContext(s.user) };
				})
				.addNode('lookup', async () => {
					guard();
					const saved = await adapter.lookupCompleted(request.requestId, hash);
					return saved
						? {
								result: {
									status: 'created' as const,
									requestId: request.requestId,
									...saved,
									metadata: metadata()
								}
							}
						: {};
				})
				.addNode('quota', async () => {
					guard();
					if (!(await adapter.consumeQuota())) {
						throw new SemanticError(429, 'quota_exceeded');
					}
					return {};
				})
				.addNode('extract', async (s) => {
					guard();
					return { extraction: await deps.extractEntry(request.text, s.context, signal) };
				})
				.addNode('validate', async (s) => {
					guard();
					const validation = normalizeExtraction(s.extraction.raw, s.context);
					return {
						validation,
						...(validation.status === 'rejected'
							? {
									result: {
										status: 'rejected' as const,
										requestId: request.requestId,
										issues: validation.issues
									}
								}
							: {})
					};
				})
				.addNode('persist', async (s) => {
					guard();
					if (s.validation.status !== 'valid') {
						throw new SemanticError(502, 'invalid_graph_state');
					}
					try {
						const completed = await adapter.persistExpense(
							request.requestId,
							hash,
							s.validation.expense
						);
						return {
							result: {
								status: 'created' as const,
								requestId: request.requestId,
								...completed,
								metadata: metadata(s.extraction)
							}
						};
					} catch (e) {
						if (e instanceof SemanticError && !e.uncertain) {
							throw e;
						}
						throw new SemanticError(504, 'persist_uncertain', true);
					}
				})
				.addNode('emit_result', (s) => {
					log('emit_result', s.result.status);
					return {};
				})
				.addEdge(START, 'authenticate')
				.addEdge('authenticate', 'load_context')
				.addEdge('load_context', 'lookup')
				.addConditionalEdges('lookup', (s) => (s.result ? 'emit_result' : 'quota'), [
					'emit_result',
					'quota'
				])
				.addEdge('quota', 'extract')
				.addEdge('extract', 'validate')
				.addConditionalEdges(
					'validate',
					(s) => (s.validation.status === 'valid' ? 'persist' : 'emit_result'),
					['persist', 'emit_result']
				)
				.addEdge('persist', 'emit_result')
				.addEdge('emit_result', END)
				.compile();
			const final = await graph.invoke({}, { callbacks: [] });
			return final.result;
		}
	};
}
