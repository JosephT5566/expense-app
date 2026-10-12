import { vi } from 'vitest';
import type { GraphDependencies, ExtractionResult } from '../src/graph';
import { context, raw, row } from './fixtures';
export function setup() {
	const adapter = {
		authenticate: vi.fn(async () => ({ id: 'a', email: 'a@example.test' })),
		loadContext: vi.fn(async () => context),
		lookupCompleted: vi.fn(
			async (): Promise<{ expense: typeof row; replayed: boolean } | null> => null
		),
		consumeQuota: vi.fn(async () => true),
		persistExpense: vi.fn(async () => ({ expense: row, replayed: false }))
	};
	const extractEntry = vi.fn(
		async (): Promise<ExtractionResult> => ({
			raw,
			model: 'synthetic',
			inputTokens: null,
			outputTokens: null
		})
	);
	const log = vi.fn();
	const deps: GraphDependencies = { createAdapter: () => adapter, extractEntry, log };
	return { adapter, extractEntry, log, deps };
}
