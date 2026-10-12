import type { ExpenseRow, SemanticContext } from '@jopie/semantic-entry-contract';
export const requestId = '12345678-1234-4123-8123-123456789abc';
export const request = { requestId, text: '午餐851' };
export const context: SemanticContext = {
	today: '2026-03-01',
	currentUserEmail: 'a@example.test',
	members: [
		{ id: 'a', email: 'a@example.test', name: '甲' },
		{ id: 'b', email: 'b@example.test', name: '乙' }
	],
	categories: [{ id: '11111111-1111-4111-8111-111111111111', name: '其他' }],
	otherCategoryId: '11111111-1111-4111-8111-111111111111'
};
export const raw = {
	note: '午餐',
	amount: 851,
	currency: null,
	date: { kind: 'missing', value: null },
	payerId: null,
	scope: null,
	hasSharedIntent: false,
	splitMemberIds: null,
	categoryId: null,
	unsupportedReason: null
};
export const row: ExpenseRow = {
	id: '22222222-2222-4222-8222-222222222222',
	payer_email: 'a@example.test',
	note: '午餐',
	amount: 851,
	currency: 'TWD',
	ts: '2026-02-28T16:00:00.000Z',
	scope: 'personal',
	shares_json: { 'a@example.test': 851 },
	category_id: context.otherCategoryId,
	is_settled: true,
	meta: '',
	created_at: '2026-03-01T00:00:00Z',
	updated_at: '2026-03-01T00:00:00Z'
};
