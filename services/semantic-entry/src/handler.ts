import { parseRequest } from '@jopie/semantic-entry-contract';
import { buildSemanticGraph, type GraphDependencies } from './graph';
import { SemanticError } from './errors';
export interface HandlerDependencies extends GraphDependencies {
	allowedOrigins?: string[];
	httpDeadlineMs?: number;
}
async function readBody(req: Request) {
	if (!req.body) {
		throw new SemanticError(400, 'invalid_request');
	}
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			size += value.length;
			if (size > 8192) {
				await reader.cancel();
				throw new SemanticError(400, 'body_too_large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	try {
		return parseRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
	} catch {
		throw new SemanticError(400, 'invalid_request');
	}
}
export async function handleSemanticRequest(
	req: Request,
	deps: HandlerDependencies
): Promise<Response> {
	const origin = req.headers.get('Origin');
	const cors: Record<string, string> = { Vary: 'Origin', 'Cache-Control': 'no-store' };
	if (origin) {
		if (!deps.allowedOrigins?.includes(origin)) {
			return Response.json(
				{ error: { code: 'origin_forbidden', uncertain: false } },
				{ status: 403, headers: cors }
			);
		}
		cors['Access-Control-Allow-Origin'] = origin;
	}
	if (req.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...cors,
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Authorization, Content-Type'
			}
		});
	}
	const path = new URL(req.url).pathname;
	if (path === '/healthz' && req.method === 'GET') {
		return Response.json({ status: 'ok' }, { headers: cors });
	}
	const statusId = path.match(/^\/semantic-entry\/([^/]+)$/)?.[1];
	if (path !== '/semantic-entry' && !statusId) {
		return Response.json(
			{ error: { code: 'not_found', uncertain: false } },
			{ status: 404, headers: cors }
		);
	}
	if ((statusId && req.method !== 'GET') || (!statusId && req.method !== 'POST')) {
		return Response.json(
			{ error: { code: 'method_not_allowed', uncertain: false } },
			{ status: 405, headers: cors }
		);
	}
	const token = req.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
	if (!token) {
		return Response.json(
			{ error: { code: 'unauthorized', uncertain: false } },
			{ status: 401, headers: cors }
		);
	}
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, req.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new SemanticError(504, 'persist_uncertain', true));
		}, deps.httpDeadlineMs ?? 30000);
	});
	try {
		const operation = async () => {
			if (statusId) {
				let id: string;
				try {
					id = parseRequest({ requestId: statusId, text: 'status' }).requestId;
				} catch {
					throw new SemanticError(400, 'invalid_request');
				}
				const adapter = deps.createAdapter(token, signal);
				const user = await adapter.authenticate();
				await adapter.loadContext(user);
				signal.throwIfAborted();
				const saved = await adapter.lookupCompleted(id);
				return Response.json(
					saved
						? { status: 'completed', requestId: id, ...saved }
						: { status: 'not_found', requestId: id },
					{ headers: cors }
				);
			}
			const request = await readBody(req);
			signal.throwIfAborted();
			const result = await buildSemanticGraph(deps).invoke({ request, token, signal });
			return Response.json(result, {
				status: result.status === 'rejected' ? 422 : 200,
				headers: cors
			});
		};
		return await Promise.race([operation(), deadline]);
	} catch (error) {
		const e =
			error instanceof SemanticError
				? error
				: new SemanticError(
						signal.aborted ? 504 : 502,
						signal.aborted ? 'persist_uncertain' : 'service_error',
						signal.aborted
					);
		return Response.json(
			{ error: { code: e.code, uncertain: e.uncertain } },
			{ status: e.status, headers: cors }
		);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
