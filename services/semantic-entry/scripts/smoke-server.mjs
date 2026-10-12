// Synthetic dependencies exercise real container HTTP + graph wiring without model/DB calls.
import { createHttpServer } from '/app/services/semantic-entry/dist/server.js';
const row = {
	id: '22222222-2222-4222-8222-222222222222',
	note: 'synthetic lunch',
	amount: 100,
	currency: 'TWD',
	payer_email: 'a@example.test',
	scope: 'personal',
	shares_json: { 'a@example.test': 100 },
	ts: '2026-02-28T16:00:00.000Z',
	category_id: 'other',
	is_settled: true,
	meta: '',
	created_at: '2026-03-01T00:00:00Z',
	updated_at: '2026-03-01T00:00:00Z'
};
const context = {
	today: '2026-03-01',
	currentUserEmail: 'a@example.test',
	members: [{ id: 'a', email: 'a@example.test', name: 'Synthetic' }],
	categories: [{ id: 'other', name: '其他' }],
	otherCategoryId: 'other'
};
createHttpServer({
	createAdapter: () => ({
		authenticate: async () => ({ id: 'a', email: 'a@example.test' }),
		loadContext: async () => context,
		lookupCompleted: async () => null,
		consumeQuota: async () => true,
		persistExpense: async () => ({ expense: row, replayed: false })
	}),
	extractEntry: async () => ({
		raw: {
			note: 'synthetic lunch',
			amount: 100,
			currency: null,
			date: { kind: 'missing', value: null },
			payerId: null,
			scope: null,
			hasSharedIntent: false,
			splitMemberIds: null,
			categoryId: null,
			unsupportedReason: null
		},
		model: 'synthetic',
		inputTokens: null,
		outputTokens: null
	})
}).listen(8080, '0.0.0.0');
