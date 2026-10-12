import { describe, expect, it } from 'vitest';
import { parseRequest, parseResponse, parseStatusResponse } from '@jopie/semantic-entry-contract';
import { normalizeExtraction } from '../src/normalize';

export const context = {
	today: '2026-03-01',
	currentUserEmail: 'a@example.test',
	members: [
		{ id: 'a', email: 'a@example.test', name: '甲' },
		{ id: 'b', email: 'b@example.test', name: '乙' }
	],
	categories: [
		{ id: 'food', name: '餐飲' },
		{ id: 'other', name: '其他' }
	],
	otherCategoryId: 'other'
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
const requestId = '12345678-1234-4123-8123-123456789abc';

describe('automatic entry rules', () => {
	it('defaults to Taiwan today and a settled personal full share', () => {
		expect(normalizeExtraction(raw, context)).toEqual({
			status: 'valid',
			expense: {
				note: '午餐',
				amount: 851,
				currency: 'TWD',
				ts: '2026-02-28T16:00:00.000Z',
				payer_email: 'a@example.test',
				scope: 'personal',
				shares_json: { 'a@example.test': 851 },
				category_id: 'other',
				is_settled: true
			}
		});
	});
	it.each([
		['yesterday', '2026-02-27T16:00:00.000Z'],
		['day_before_yesterday', '2026-02-26T16:00:00.000Z']
	])('resolves %s across Taiwan month boundaries', (kind, ts) => {
		expect(normalizeExtraction({ ...raw, date: { kind, value: null } }, context)).toMatchObject(
			{ status: 'valid', expense: { ts } }
		);
	});
	it('splits 851 as 426/425 in email order regardless of input order', () => {
		expect(
			normalizeExtraction(
				{ ...raw, scope: 'household', hasSharedIntent: true, splitMemberIds: ['b', 'a'] },
				context
			)
		).toMatchObject({
			status: 'valid',
			expense: {
				shares_json: { 'a@example.test': 426, 'b@example.test': 425 },
				is_settled: false
			}
		});
	});
	it.each([
		{ amount: null },
		{ amount: 0 },
		{ amount: -1 },
		{ amount: 1.5 },
		{ amount: Number.MAX_SAFE_INTEGER + 1 },
		{ payerId: 'unknown' },
		{ payerId: 'b' },
		{ note: ' ' },
		{ currency: 'USD' },
		{ unsupportedReason: 'refund' },
		{ unsupportedReason: 'multiple' },
		{ categoryId: 'unknown' },
		{ date: { kind: 'absolute', value: '2026-02-30' } },
		{ date: { kind: 'absolute', value: '2026-03-02' } },
		{ hasSharedIntent: true },
		{ scope: 'household' },
		{ splitMemberIds: ['a', 'b'] },
		{ scope: 'household', splitMemberIds: ['a', 'a'] },
		{ scope: 'household', splitMemberIds: ['a', 'unknown'] },
		{ extra: true },
		{ amount: '851' },
		{ date: { kind: 'bogus', value: null } }
	])('rejects malformed or unsupported extraction %j', (patch) => {
		expect(normalizeExtraction({ ...raw, ...patch }, context).status).toBe('rejected');
	});
	it('rejects missing fallback configuration even when other is guessed', () => {
		expect(normalizeExtraction(raw, { ...context, otherCategoryId: 'absent' })).toMatchObject({
			status: 'rejected',
			issues: [{ field: 'categoryId', code: 'configuration' }]
		});
	});
	it('accepts an explicit known category without a fallback', () => {
		expect(
			normalizeExtraction({ ...raw, categoryId: 'food' }, { ...context, otherCategoryId: '' })
		).toMatchObject({ status: 'valid', expense: { category_id: 'food' } });
	});
	it('rejects ambiguous member configuration', () => {
		expect(
			normalizeExtraction(
				{ ...raw, payerId: 'a' },
				{
					...context,
					members: [...context.members, { id: 'a', email: 'c@example.test', name: '丙' }]
				}
			).status
		).toBe('rejected');
	});
});

describe('portable runtime contracts', () => {
	it('trims and counts Unicode code points rather than UTF-16 units', () => {
		expect(parseRequest({ requestId, text: ` ${'🍜'.repeat(500)} ` }).text).toHaveLength(1000);
		expect(() => parseRequest({ requestId, text: '🍜'.repeat(501) })).toThrow();
	});
	it.each([
		{ requestId: 'bad', text: '午餐100' },
		{ requestId, text: ' ' },
		{ requestId, text: '午餐100', userId: 'a' },
		{ requestId, text: '午餐100', hash: 'x' }
	])('rejects invalid request %j', (input) => {
		expect(() => parseRequest(input)).toThrow();
	});
	it('validates a rejected response and refuses a malformed created snapshot', () => {
		expect(
			parseResponse({
				status: 'rejected',
				requestId,
				issues: [{ field: 'amount', code: 'missing' }]
			}).status
		).toBe('rejected');
		expect(() =>
			parseResponse({
				status: 'created',
				requestId,
				expense: {},
				replayed: false,
				metadata: {}
			})
		).toThrow();
		expect(() =>
			parseResponse({
				status: 'rejected',
				requestId,
				issues: [{ field: 'amount', code: 'invented' }]
			})
		).toThrow();
	});
	it('distinguishes not_found from a completed result', () => {
		expect(parseStatusResponse({ status: 'not_found', requestId })).toEqual({
			status: 'not_found',
			requestId
		});
		expect(() =>
			parseStatusResponse({ status: 'completed', requestId, expense: {}, replayed: true })
		).toThrow();
	});
});
