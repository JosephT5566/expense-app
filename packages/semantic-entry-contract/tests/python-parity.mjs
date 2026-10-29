// Node is used only to exercise the actual browser validator against Python outputs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
	parseUploadRequest,
	parseDraftV3,
	parseRequestV3,
	parseResponseV3,
	parseStatusResponseV3,
	parseStreamEventV3,
	loadJsonV3,
	parseRequest,
	parseResponse,
	parseStatusResponse,
	parseStreamEvent
} from '../src/index.ts';
const service = fileURLToPath(new URL('../../../services/semantic-entry/', import.meta.url));
const python = process.env.SEMANTIC_TEST_PYTHON ?? `${service}.venv/bin/python`;
const cases = JSON.parse(
	execFileSync(python, ['tests/export_contract.py'], { cwd: service, encoding: 'utf8' })
);
for (const item of cases.requests) {
	if (item.invalid) {
		assert.throws(() => parseRequest(item.raw));
	} else {
		const parsed = parseRequest(item.raw);
		assert.deepEqual(parsed, item.parsed);
		const payload = parsed.referenceDate
			? `v3\n${JSON.stringify({ text: parsed.text, history: parsed.history ?? [], referenceDate: parsed.referenceDate })}`
			: parsed.history
				? `v2\n${JSON.stringify({ text: parsed.text, history: parsed.history })}`
				: `v1\n${parsed.text}`;
		assert.equal(createHash('sha256').update(payload).digest('hex'), item.hash);
	}
}
for (const item of cases.responses) {
	const parsed =
		item.kind === 'response' ? parseResponse(item.body) : parseStatusResponse(item.body);
	assert.deepEqual(parsed, item.body);
}
for (const item of cases.streams) {
	assert.deepEqual(
		parseStreamEvent(item.event, item.body),
		item.event === 'result'
			? { type: 'result', result: item.body }
			: item.event === 'analysis_delta'
				? { type: 'analysis_delta', ...item.body }
				: { type: 'persisting', requestId: item.body.requestId }
	);
}
console.log(
	`Python/browser contract parity: ${cases.requests.length} requests and ${cases.responses.length} HTTP responses and ${cases.streams.length} SSE events passed`
);
// Preserve malformed-response checks previously hosted in the Node backend suite.
const id = cases.requests[0].parsed.requestId;
assert.throws(() =>
	parseResponse({ status: 'created', requestId: id, expense: {}, replayed: false, metadata: {} })
);
assert.throws(() =>
	parseResponse({
		status: 'rejected',
		requestId: id,
		issues: [{ field: 'amount', code: 'invented' }]
	})
);
assert.throws(() =>
	parseStatusResponse({ status: 'completed', requestId: id, expense: {}, replayed: true })
);

assert.throws(() => parseStreamEvent('persisting', { status: 'persisting', requestId: 'bad' }));
assert.throws(() => parseStreamEvent('error', { error: { code: 'x', uncertain: 'false' } }));
assert.throws(() => parseStreamEvent('invented', {}));
assert.throws(() =>
	parseResponse({
		status: 'needs_input',
		requestId: id,
		question: 'q'.repeat(301),
		issues: [{ field: 'amount', code: 'missing' }]
	})
);

for (const body of [
	{ requestId: 'bad', seq: 0, text: '午餐' },
	{ requestId: id, seq: -1, text: '午餐' },
	{ requestId: id, seq: 0.5, text: '午餐' },
	{ requestId: id, seq: 0, text: '' },
	{ requestId: id, seq: 0, text: '🍜'.repeat(201) },
	{ requestId: id, seq: 0, text: '\uD800' },
	{ requestId: id, seq: 0, text: '午餐', extra: true }
]) {
	assert.throws(() => parseStreamEvent('analysis_delta', body));
}

const clientDraftHashes = new Map();

// V3 cases have independent expected acceptance/rejection in the Python fixture.
for (const item of cases.v3) {
	const parse = () =>
		item.kind === 'stream'
			? parseStreamEventV3(item.event, item.raw)
			: {
					request: parseRequestV3,
					draft: parseDraftV3,
					response: parseResponseV3,
					status: parseStatusResponseV3
				}[item.kind](item.raw);
	if (item.invalid) {
		assert.throws(parse, item.name);
	} else {
		const parsed = parse();
		assert.deepEqual(parsed, item.parsed, item.name);
		if (item.kind === 'request') {
			assert.throws(() => parseRequest(item.raw));
			for (const draft of parsed.drafts ?? []) {
				for (const key of ['status', 'issues', 'updated']) {
					assert.equal(Object.hasOwn(draft, key), false, item.name);
				}
			}
			let payload;
			if (parsed.images || parsed.drafts) {
				const drafts = parsed.drafts ?? [];
				payload = `v4\n${JSON.stringify({ action: parsed.action, text: parsed.text ?? '', history: parsed.history ?? [], referenceDate: parsed.referenceDate ?? null, images: item.images, drafts })}`;
			} else {
				payload = parsed.referenceDate
					? `v3\n${JSON.stringify({ text: parsed.text, history: parsed.history ?? [], referenceDate: parsed.referenceDate })}`
					: parsed.history
						? `v2\n${JSON.stringify({ text: parsed.text, history: parsed.history })}`
						: `v1\n${parsed.text}`;
			}
			const hash = createHash('sha256').update(payload).digest('hex');
			assert.equal(hash, item.hash, item.name);
			if (item.name.startsWith('client-computed-')) {
				const previous = clientDraftHashes.get(parsed.action);
				if (previous) {
					assert.equal(hash, previous, item.name);
				}
				clientDraftHashes.set(parsed.action, hash);
			}
		}
	}
}
for (const text of cases.jsonInvalidV3) {
	assert.throws(() => loadJsonV3(text));
}
assert.deepEqual(loadJsonV3('{"a":[{},[],{"x":1}],"b":"é"}'), { a: [{}, [], { x: 1 }], b: 'é' });
for (const number of [NaN, Infinity, -Infinity]) {
	const draft = structuredClone(
		cases.v3.find((item) => item.kind === 'draft' && !item.invalid).raw
	);
	draft.note.confidence = number;
	assert.throws(() => parseDraftV3(draft));
	draft.note.confidence = null;
	draft.amount.value = number;
	assert.throws(() => parseDraftV3(draft));
}
console.log(
	`V3 Python/browser contract parity: ${cases.v3.length} acceptance/rejection vectors and v4 hashes passed`
);

for (const item of cases.uploads) {
	if (item.invalid) {
		assert.throws(() => parseUploadRequest(item.raw));
	} else {
		assert.deepEqual(parseUploadRequest(item.raw), item.parsed);
	}
}
console.log(`Upload request parity: ${cases.uploads.length} cases passed`);
