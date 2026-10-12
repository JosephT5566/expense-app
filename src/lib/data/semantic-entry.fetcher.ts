import { env } from '$env/dynamic/public';
import { supabase } from '$lib/supabase/supabaseClient';
import {
	parseRequest,
	parseResponse,
	parseStatusResponse,
	type CompletedResult,
	type SemanticRequest,
	type SemanticResponse
} from '@jopie/semantic-entry-contract';
export class SemanticEntryError extends Error {
	constructor(
		public code: string,
		public uncertain: boolean
	) {
		super(code);
	}
}
async function call(
	path: string,
	method: 'GET' | 'POST',
	body?: SemanticRequest,
	signal?: AbortSignal
): Promise<unknown> {
	const base = env.PUBLIC_SEMANTIC_ENTRY_URL;
	if (!base) {
		throw new SemanticEntryError('configuration', false);
	}
	let url: URL;
	try {
		url = new URL(`/semantic-entry${path}`, base);
		if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
			throw new Error('Invalid endpoint');
		}
	} catch {
		throw new SemanticEntryError('configuration', false);
	}
	const { data, error } = await supabase.auth.getSession();
	if (error || !data.session?.access_token) {
		throw new SemanticEntryError('unauthorized', false);
	}
	signal?.throwIfAborted();
	try {
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${data.session.access_token}`,
				...(body ? { 'Content-Type': 'application/json' } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.any([
				signal ?? new AbortController().signal,
				AbortSignal.timeout(32000)
			])
		});
		const result = await response.json();
		if (!response.ok && response.status !== 422) {
			throw new SemanticEntryError(
				typeof result?.error?.code === 'string' ? result.error.code : 'service_error',
				typeof result?.error?.uncertain === 'boolean'
					? result.error.uncertain
					: response.status >= 500
			);
		}
		return result;
	} catch (error) {
		if (error instanceof SemanticEntryError) {
			throw error;
		}
		throw new SemanticEntryError('connection', true);
	}
}
export async function submitSemanticEntry(
	request: SemanticRequest,
	signal?: AbortSignal
): Promise<SemanticResponse> {
	let parsed: SemanticRequest;
	try {
		parsed = parseRequest(request);
	} catch {
		throw new SemanticEntryError('invalid_request', false);
	}
	const result = await call('', 'POST', parsed, signal);
	try {
		const response = parseResponse(result);
		if (response.requestId !== parsed.requestId) {
			throw new Error('Request mismatch');
		}
		return response;
	} catch {
		throw new SemanticEntryError('invalid_response', true);
	}
}
export async function getSemanticEntryStatus(
	requestId: string,
	signal?: AbortSignal
): Promise<CompletedResult | null> {
	const result = await call(`/${encodeURIComponent(requestId)}`, 'GET', undefined, signal);
	try {
		const response = parseStatusResponse(result);
		if (response.requestId !== requestId) {
			throw new Error('Request mismatch');
		}
		return response.status === 'not_found'
			? null
			: { expense: response.expense, replayed: true };
	} catch {
		throw new SemanticEntryError('invalid_response', true);
	}
}
