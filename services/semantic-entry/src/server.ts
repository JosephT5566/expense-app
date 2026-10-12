import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleSemanticRequest, type HandlerDependencies } from './handler';
import { createProvider } from './provider';
import { createSupabaseAdapter } from './supabase';
// Never allow environment-enabled external payload tracing.
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';
export function createHttpServer(deps: HandlerDependencies): Server {
	const server = createServer(async (incoming, outgoing) => {
		const controller = new AbortController();
		outgoing.on('close', () => controller.abort());
		const headers = new Headers();
		for (const [key, value] of Object.entries(incoming.headers)) {
			if (value !== undefined) {
				headers.set(key, Array.isArray(value) ? value.join(',') : value);
			}
		}
		const init: RequestInit & { duplex?: 'half' } = {
			method: incoming.method,
			headers,
			signal: controller.signal
		};
		if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
			init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
			init.duplex = 'half';
		}
		try {
			const response = await handleSemanticRequest(
				new Request(`http://localhost${incoming.url ?? '/'}`, init),
				deps
			);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			if (!outgoing.headersSent) {
				outgoing.writeHead(502, { 'Content-Type': 'application/json' });
			}
			outgoing.end(JSON.stringify({ error: { code: 'service_error', uncertain: true } }));
		}
	});
	server.requestTimeout = 30000;
	server.headersTimeout = 30000;
	return server;
}
function environmentDependencies(): HandlerDependencies {
	const names: unknown = JSON.parse(process.env.SEMANTIC_MEMBER_NAMES ?? '{}');
	if (
		!names ||
		typeof names !== 'object' ||
		Array.isArray(names) ||
		Object.values(names).some((v) => typeof v !== 'string')
	) {
		throw new Error('Invalid SEMANTIC_MEMBER_NAMES configuration');
	}
	return {
		allowedOrigins: (process.env.SEMANTIC_ALLOWED_ORIGINS ?? '')
			.split(',')
			.map((v) => v.trim())
			.filter(Boolean),
		createAdapter: (token, signal) =>
			createSupabaseAdapter(
				{
					url: process.env.SUPABASE_URL ?? '',
					publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
					otherCategoryId: process.env.SEMANTIC_OTHER_CATEGORY_ID ?? '',
					memberNames: names as Record<string, string>
				},
				token,
				signal
			),
		extractEntry: createProvider({
			apiKey: process.env.OPENAI_API_KEY ?? '',
			model: process.env.SEMANTIC_MODEL ?? 'gpt-5.4-mini'
		}),
		log: (event) => {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
	};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	createHttpServer(environmentDependencies()).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}
