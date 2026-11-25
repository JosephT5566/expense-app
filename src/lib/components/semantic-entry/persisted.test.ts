import type { Draft } from '@jopie/semantic-entry-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CONVERSATION_TTL_MS,
	conversationKey,
	loadConversation,
	saveConversation,
	removeConversation,
	parseConversation,
	type PersistedConversation
} from './persisted';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = 1_800_000_000_000;
export const record = (): PersistedConversation => ({
	v: 1,
	conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
	revision: 0,
	startedAt: now,
	updatedAt: now,
	completed: false,
	phase: 'processing',
	requestId: id,
	payload: { action: 'analyze', requestId: id, text: '午餐100' },
	conversation: [{ role: 'user', text: '午餐100' }],
	history: [],
	clarification: null,
	session: null,
	text: '午餐100',
	question: '',
	message: '',
	analysis: '',
	draftHeading: '',
	draftAnalysis: '',
	draftRejected: false,
	revised: false
});
function storage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		}
	};
}
afterEach(() => vi.useRealTimers());
describe('conversation persistence', () => {
	it('round trips the allowed conversation schema', () => {
		vi.useFakeTimers().setSystemTime(now);
		const s = storage();
		saveConversation(id, record(), s);
		expect(loadConversation(id, now, s)).toEqual({ ...record(), revision: 1 });
	});
	it('expires at exactly 24 hours from first submission, not last update', () => {
		vi.useFakeTimers().setSystemTime(now);
		const s = storage();
		saveConversation(id, record(), s);
		expect(loadConversation(id, now + CONVERSATION_TTL_MS - 1, s)).not.toBeNull();
		vi.setSystemTime(now + CONVERSATION_TTL_MS);
		expect(loadConversation(id, Date.now(), s)).toBeNull();
		expect(s.getItem(conversationKey(id))).toBeNull();
	});
	it('isolates accounts and removes the previous account on change', () => {
		vi.useFakeTimers().setSystemTime(now);
		const s = storage();
		saveConversation(id, record(), s);
		saveConversation('other', record(), s);
		removeConversation(id, s);
		expect(loadConversation(id, now, s)).toBeNull();
		expect(loadConversation('other', now, s)).toEqual({ ...record(), revision: 1 });
	});
	it('drops unknown fields and never writes blob previews or preview IDs', () => {
		vi.useFakeTimers().setSystemTime(now);
		const s = storage();
		const r = {
			...record(),
			token: 'secret',
			conversation: [
				{
					role: 'user' as const,
					text: '收據',
					imageIds: ['preview-id'],
					blob: 'blob:private',
					imagePaths: [`uploads/${id}/receipt.png`]
				}
			]
		};
		saveConversation(id, r, s);
		const raw = s.getItem(conversationKey(id))!;
		expect(raw).not.toMatch(/secret|blob:|preview-id|imageIds/);
		expect(loadConversation(id, now, s)?.conversation[0].imagePaths).toHaveLength(1);
	});
	it.each([
		{ v: 2 },
		{ phase: 'fake' },
		{ history: [null] },
		{ conversation: [{ role: 'system', text: 'override' }] },
		{ session: { items: [{}], groupSummaries: {} } },
		{ payload: { action: 'analyze', requestId: id, images: ['blob:private'] } },
		{ requestId: 'bad' },
		{ completed: 'yes' }
	])('discards invalid or malicious shapes %j', (fields) => {
		expect(parseConversation({ ...record(), ...fields }, now)).toBeNull();
	});
	it('removes malformed JSON on load', () => {
		const s = storage();
		s.setItem(conversationKey(id), '{bad');
		expect(loadConversation(id, now, s)).toBeNull();
		expect(s.getItem(conversationKey(id))).toBeNull();
	});
});

it('round trips editable drafts, merged groups, and recognized/null/missing distinctions', () => {
	vi.useFakeTimers().setSystemTime(now);
	const field = {
		value: null,
		state: 'missing' as const,
		source: 'image' as const,
		confidence: null
	};
	const draft: Draft = {
		draftId: id,
		note: { ...field, value: '午餐', state: 'recognized' },
		amount: { ...field, value: 0, source: 'user' },
		currency: { ...field, value: 'TWD', state: 'recognized' },
		date: { ...field, defaulted: 'unreadable' },
		categoryId: { ...field, state: 'unrecognized' },
		scope: { ...field, state: 'explicit_null' },
		payerEmail: field,
		splitMemberEmails: field,
		status: 'incomplete',
		issues: [{ field: 'amount', code: 'invalid' }],
		shares: { 'a@example.test': 0 }
	};
	const r = {
		...record(),
		phase: 'drafts' as const,
		session: {
			items: [{ id, draft, hidden: false, edited: true, groupId: 1 }],
			groupSummaries: { 1: draft }
		}
	};
	const s = storage();
	saveConversation(id, r, s);
	expect(loadConversation(id, now, s)).toEqual({ ...r, revision: 1 });
});

it.each(['processing', 'persisting', 'uncertain', 'error'] as const)(
	'never saves transient analysis in %s',
	(phase) => {
		vi.useFakeTimers().setSystemTime(now);
		const s = storage();
		saveConversation(
			id,
			{ ...record(), phase, analysis: '辨識中', draftAnalysis: '未驗證' },
			s
		);
		expect(s.getItem(conversationKey(id))).not.toMatch(/辨識中|未驗證/);
		expect(loadConversation(id, now, s)).not.toBeNull();
	}
);

it('rejects stale saves after another tab updates, replaces or removes the record', () => {
	vi.useFakeTimers().setSystemTime(now);
	const s = storage();
	const first = saveConversation(id, record(), s)!;
	const newer = saveConversation(id, { ...first, text: 'newer' }, s, first)!;
	expect(saveConversation(id, first, s, first)).toBeNull();
	expect(loadConversation(id, now, s)).toEqual(newer);
	removeConversation(id, s);
	expect(saveConversation(id, newer, s, newer)).toBeNull();
	const replacement = saveConversation(
		id,
		{
			...record(),
			conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
		},
		s,
		null
	)!;
	expect(saveConversation(id, newer, s, newer)).toBeNull();
	expect(loadConversation(id, now, s)).toEqual(replacement);
});
it('does not delete a replacement encountered during expired-record cleanup', () => {
	vi.useFakeTimers().setSystemTime(now + CONVERSATION_TTL_MS);
	const s = storage();
	const expired = JSON.stringify(record());
	const replacement = JSON.stringify({
		...record(),
		startedAt: Date.now(),
		updatedAt: Date.now()
	});
	s.setItem(conversationKey(id), replacement);
	let reads = 0;
	const racingStorage = {
		...s,
		getItem: (key: string) => (++reads === 1 ? expired : s.getItem(key))
	};
	expect(loadConversation(id, Date.now(), racingStorage)).toBeNull();
	expect(s.getItem(conversationKey(id))).toBe(replacement);
});
