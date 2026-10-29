import { env } from '$env/dynamic/public';
import { supabase } from '$lib/supabase/supabaseClient';
import {
	parseRequestV3,
	parseResponseV3,
	parseStatusResponseV3,
	parseStreamEventV3,
	MAX_REQUEST_BYTES_V3,
	parseUploadRequest,
	parseUploadResponse,
	type UploadRequest,
	type UploadTarget,
	type ExpenseRow,
	type SemanticRequestV3,
	type SemanticResponseV3
} from '@jopie/semantic-entry-contract';
export type SemanticAnalysisDelta = { requestId: string; seq: number; text: string };
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
	body?: SemanticRequestV3 | UploadRequest,
	signal?: AbortSignal,
	onPersisting?: () => void,
	onAnalysis?: (delta: SemanticAnalysisDelta) => void
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
	let writing = false;
	try {
		const payload = body ? JSON.stringify(body) : undefined;
		if (payload && new TextEncoder().encode(payload).length > MAX_REQUEST_BYTES_V3) {
			throw new SemanticEntryError('invalid_request', false);
		}
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${data.session.access_token}`,
				...(body
					? {
							'Content-Type': 'application/json',
							Accept:
								path === '/uploads'
									? 'application/json'
									: 'text/event-stream; semantic-version=3'
						}
					: { Accept: 'application/json; semantic-version=3' })
			},
			...(payload ? { body: payload } : {}),
			signal: AbortSignal.any([
				signal ?? new AbortController().signal,
				AbortSignal.timeout(
					body && 'action' in body && body.action === 'analyze' && body.images
						? 92000
						: 32000
				)
			])
		});
		if (
			body &&
			'requestId' in body &&
			response.ok &&
			response.headers.get('Content-Type')?.includes('text/event-stream')
		) {
			if (!response.body) {
				throw new SemanticEntryError('invalid_response', true);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder('utf-8', { fatal: true });
			let buffer = '';
			let size = 0;
			let nextSeq = 0;
			let analysisCodePoints = 0;
			let terminalResult: SemanticResponseV3 | undefined;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) {
						buffer += decoder.decode();
						if (terminalResult && !buffer.trim()) {
							return terminalResult;
						}
						throw new SemanticEntryError('invalid_response', true);
					}
					size += value.length;
					if (size > 65536) {
						throw new SemanticEntryError('invalid_response', true);
					}
					buffer += decoder.decode(value, { stream: true });
					// SSE accepts LF and CRLF; preserve CR at chunk boundaries.
					let boundary: RegExpExecArray | null;
					while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
						const frame = buffer.slice(0, boundary.index);
						buffer = buffer.slice(boundary.index + boundary[0].length);
						let name = '';
						const data: string[] = [];
						for (const line of frame.split(/\r?\n/)) {
							if (line.startsWith('event:')) {
								name = line.slice(6).trim();
							} else if (line.startsWith('data:')) {
								data.push(line.slice(5).replace(/^ /, ''));
							}
						}
						if (!data.length) {
							continue;
						}
						if (terminalResult) {
							throw new SemanticEntryError('invalid_response', true);
						}
						let event;
						try {
							event = parseStreamEventV3(name, JSON.parse(data.join('\n')));
						} catch {
							throw new SemanticEntryError('invalid_response', true);
						}
						if (event.type === 'error') {
							throw new SemanticEntryError(event.code, writing || event.uncertain);
						}
						const id =
							event.type === 'result' ? event.result.requestId : event.requestId;
						if (id !== body.requestId) {
							throw new SemanticEntryError('invalid_response', true);
						}
						if (event.type === 'analysis_delta') {
							analysisCodePoints += [...event.text].length;
							if (writing || event.seq !== nextSeq || analysisCodePoints > 200) {
								throw new SemanticEntryError('invalid_response', true);
							}
							nextSeq++;
							onAnalysis?.(event);
							continue;
						}
						if (event.type === 'persisting') {
							if (writing) {
								throw new SemanticEntryError('invalid_response', true);
							}
							writing = true;
							onPersisting?.();
						} else {
							if (writing && event.result.status !== 'created') {
								throw new SemanticEntryError('invalid_response', true);
							}
							terminalResult = event.result;
						}
					}
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
		const result = await response.json().catch(() => {
			throw new SemanticEntryError('invalid_response', path !== '/uploads');
		});
		if (!response.ok && (path === '/uploads' || response.status !== 422)) {
			throw new SemanticEntryError(
				typeof result?.error?.code === 'string' ? result.error.code : 'service_error',
				path === '/uploads'
					? false
					: typeof result?.error?.uncertain === 'boolean'
						? result.error.uncertain
						: response.status >= 500
			);
		}
		return result;
	} catch (error) {
		if (error instanceof SemanticEntryError) {
			throw error;
		}
		throw new SemanticEntryError('connection', path !== '/uploads');
	}
}
export async function submitSemanticEntry(
	request: SemanticRequestV3,
	signal?: AbortSignal,
	onPersisting?: () => void,
	onAnalysis?: (delta: SemanticAnalysisDelta) => void
): Promise<SemanticResponseV3> {
	let parsed: SemanticRequestV3;
	try {
		parsed = parseRequestV3(request);
	} catch {
		throw new SemanticEntryError('invalid_request', false);
	}
	const result = await call('', 'POST', parsed, signal, onPersisting, onAnalysis);
	try {
		const response = parseResponseV3(result);
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
): Promise<{ expenses: ExpenseRow[]; replayed: true } | null> {
	const result = await call(`/${encodeURIComponent(requestId)}`, 'GET', undefined, signal);
	try {
		const response = parseStatusResponseV3(result);
		if (response.requestId !== requestId) {
			throw new Error('Request mismatch');
		}
		return response.status === 'not_found'
			? null
			: { expenses: response.expenses, replayed: true };
	} catch {
		throw new SemanticEntryError('invalid_response', true);
	}
}

export async function requestImageUploads(
	files: UploadRequest['files'],
	signal?: AbortSignal
): Promise<UploadTarget[]> {
	let request: UploadRequest;
	try {
		request = parseUploadRequest({ files });
	} catch {
		throw new SemanticEntryError('invalid_request', false);
	}
	const result = await call('/uploads', 'POST', request, signal);
	try {
		return parseUploadResponse(result, files.length).uploads;
	} catch {
		throw new SemanticEntryError('invalid_response', false);
	}
}
export async function uploadImage(
	target: UploadTarget,
	file: Blob,
	signal?: AbortSignal
): Promise<void> {
	try {
		const response = await fetch(target.url, {
			method: 'PUT',
			headers: target.requiredHeaders,
			body: file,
			signal: AbortSignal.any([
				signal ?? new AbortController().signal,
				AbortSignal.timeout(60000)
			])
		});
		if (!response.ok) {
			throw new Error('Upload failed');
		}
	} catch {
		throw new SemanticEntryError('image_upload', false);
	}
}
