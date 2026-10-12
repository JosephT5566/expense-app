// Node is used only to exercise the actual browser validator against Python outputs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseRequest, parseResponse, parseStatusResponse } from '../src/index.ts';
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
		assert.equal(createHash('sha256').update(`v1\n${parsed.text}`).digest('hex'), item.hash);
	}
}
for (const item of cases.responses) {
	const parsed =
		item.kind === 'response' ? parseResponse(item.body) : parseStatusResponse(item.body);
	assert.deepEqual(parsed, item.body);
}
console.log(
	`Python/browser contract parity: ${cases.requests.length} requests and ${cases.responses.length} HTTP responses passed`
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
