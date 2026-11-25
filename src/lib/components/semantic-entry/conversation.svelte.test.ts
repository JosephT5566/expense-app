import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { user } from '$lib/stores/session.store';

const storage = vi.hoisted(() => {
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key),
		clear: () => data.clear()
	};
	vi.stubGlobal('localStorage', storage);
	return storage;
});
vi.mock('$lib/data/semantic-entry.fetcher', () => ({ getSemanticEntryStatus: vi.fn() }));
vi.mock('$lib/data/expenses.fetcher', () => ({
	forceRefetchMonthlyExpenses: vi.fn().mockResolvedValue(true)
}));
import { getSemanticEntryStatus } from '$lib/data/semantic-entry.fetcher';
import { saveConversation, conversationKey, type PersistedConversation } from './persisted';
vi.mock('$app/environment', () => ({ browser: true }));

import { attempts, chat, imagePreviews } from './conversation.svelte';

afterEach(() => {
	vi.useRealTimers();
});

const first = { id: 'first-account', email: 'first@example.test' };
beforeEach(() => {
	user.set(null);
	storage.clear();
	vi.mocked(getSemanticEntryStatus).mockReset();
	user.set(first);
});

it('keeps conversation and active controllers for repeated updates of the same account', () => {
	const controller = new AbortController();
	chat.controller = controller;
	chat.phase = 'processing';
	chat.conversation.push({ role: 'user', text: '午餐100' });
	user.set({ ...first });
	expect(controller.signal.aborted).toBe(false);
	expect(chat.phase).toBe('processing');
	expect(chat.processing).toBe(true);
	expect(chat.conversation).toEqual([{ role: 'user', text: '午餐100' }]);
});

it.each(['switch', 'logout'])(
	'aborts and clears prior-account work on %s without a mounted page',
	(action) => {
		const submit = new AbortController();
		const lookup = new AbortController();
		chat.controller = submit;
		chat.lookupControllers.push(lookup);
		chat.lookingUp.set('request', 'query');
		chat.lookupErrors.set('request', 'connection');
		chat.draftEditorRequested = true;
		chat.text = '午餐100';
		chat.history = [{ question: '誰付款？', answer: '我' }];
		chat.conversation.push({ role: 'user', text: '午餐100', imageIds: ['preview'] });
		chat.analysis = '辨識中';
		chat.phase = 'processing';
		chat.focusedId = 'request';
		chat.attempt = {
			action: 'analyze',
			requestId: 'request',
			text: '午餐100',
			accountId: first.id
		};
		attempts.set('request', chat.attempt);
		const url = URL.createObjectURL(new Blob(['synthetic']));
		imagePreviews.set('preview', url);
		const revoke = vi.spyOn(URL, 'revokeObjectURL');
		const revision = chat.revision;

		user.set(
			action === 'switch' ? { id: 'second-account', email: 'second@example.test' } : null
		);

		expect(submit.signal.aborted).toBe(true);
		expect(lookup.signal.aborted).toBe(true);
		expect(chat.revision).toBeGreaterThan(revision);
		expect(chat.lookupControllers).toEqual([]);
		expect(chat.lookingUp.size).toBe(0);
		expect(chat.lookupErrors.size).toBe(0);
		expect(chat.text).toBe('');
		expect(chat.history).toEqual([]);
		expect(chat.conversation).toEqual([]);
		expect(chat.analysis).toBe('');
		expect(chat.phase).toBe('input');
		expect(chat.focusedId).toBeNull();
		expect(chat.attempt).toBeNull();
		expect(chat.session).toBeNull();
		expect(chat.draftEditorRequested).toBe(false);
		expect(attempts.size).toBe(0);
		expect(imagePreviews.size).toBe(0);
		expect(revoke).toHaveBeenCalledWith(url);
		revoke.mockRestore();
	}
);

it('updates composer calculations as a background clarification response arrives', () => {
	chat.text = '午餐100';
	expect(chat.count).toBe(5);
	expect(chat.canCompose).toBe(true);
	chat.phase = 'processing';
	expect(chat.canCompose).toBe(false);
	chat.clarification = {
		status: 'needs_input',
		requestId: 'request',
		question: '誰付款？',
		issues: [{ field: 'payerId', code: 'missing' }],
		options: [{ id: 'me', label: '我' }],
		allowFreeText: false
	};
	chat.phase = 'needs_input';
	expect(chat.optionQuestion).toBe(true);
	expect(chat.canCompose).toBe(false);
	chat.reply = '我付款';
	expect(chat.composerCount).toBe(3);
});

it('refreshes the Taiwan draft date across midnight without changing retained retry payloads', () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-25T15:59:59Z'));
	chat.refreshToday();
	expect(chat.draftContext.today).toBe('2026-11-25');
	chat.attempt = {
		action: 'analyze',
		requestId: 'retry',
		text: '午餐100',
		referenceDate: chat.draftContext.today,
		accountId: first.id
	};
	attempts.set('retry', chat.attempt);
	chat.retainedCommit = {
		action: 'commit',
		requestId: 'commit-retry',
		drafts: [],
		referenceDate: chat.draftContext.today,
		accountId: first.id
	};

	vi.advanceTimersByTime(1000);
	chat.refreshToday();
	expect(chat.draftContext.today).toBe('2026-11-26');
	expect(chat.attempt.referenceDate).toBe('2026-11-25');
	expect(attempts.get('retry')?.referenceDate).toBe('2026-11-25');
	expect(chat.retainedCommit.referenceDate).toBe('2026-11-25');
});

it('retains a background draft editor request until the mounted page consumes it', () => {
	chat.draftEditorRequested = true;
	user.set({ ...first });
	expect(chat.draftEditorRequested).toBe(true);
	chat.draftEditorRequested = false;
	expect(chat.draftEditorRequested).toBe(false);
});

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function saved(phase: PersistedConversation['phase'] = 'processing'): PersistedConversation {
	return {
		v: 1,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		completed: false,
		phase,
		requestId,
		payload: { action: 'analyze', requestId, text: '午餐100' },
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
	};
}
it('restores and queries in-flight work without a mounted page, retaining the exact retry', async () => {
	user.set(null);
	saveConversation(first.id, saved(), storage);
	vi.mocked(getSemanticEntryStatus).mockResolvedValue(null);
	user.set(first);
	await vi.waitFor(() => expect(chat.resendAvailable).toBe(true));
	expect(chat.conversation[0].text).toBe('午餐100');
	expect(attempts.get(requestId)).toEqual({ ...saved().payload, accountId: first.id });
	expect(chat.message).toBe('這筆請求沒有完成，可重新送出');
	expect(chat.completed).toBe(false);
	user.set({ id: 'other', email: 'other@example.test' });
	expect(storage.getItem(conversationKey(first.id))).toBeNull();
	expect(chat.conversation).toEqual([]);
});
it('does not trust stored completion and only locks after the status GET completes', async () => {
	user.set(null);
	saveConversation(first.id, { ...saved(), completed: true }, storage);
	vi.mocked(getSemanticEntryStatus).mockResolvedValue(null);
	user.set(first);
	await vi.waitFor(() => expect(chat.checking).toBe(false));
	expect(chat.completed).toBe(false);
	expect(chat.resendAvailable).toBe(true);
	vi.mocked(getSemanticEntryStatus).mockResolvedValue({ expenses: [], replayed: true });
	await chat.lookupRestored();
	expect(chat.completed).toBe(true);
	expect(chat.readOnly).toBe(true);
	expect(chat.canCompose).toBe(false);
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!).completed).toBe(true);
});
it('retains a failed lookup and permits manual query', async () => {
	user.set(null);
	saveConversation(first.id, saved(), storage);
	vi.mocked(getSemanticEntryStatus).mockRejectedValue(new Error('offline'));
	user.set(first);
	await vi.waitFor(() => expect(chat.checking).toBe(false));
	expect(chat.phase).toBe('uncertain');
	expect(chat.message).toContain('查詢結果');
	expect(storage.getItem(conversationKey(first.id))).not.toBeNull();
	vi.mocked(getSemanticEntryStatus).mockResolvedValue(null);
	await chat.lookupRestored();
	expect(chat.resendAvailable).toBe(true);
});

it('starts the conversation TTL at image submission before upload finishes', () => {
	vi.useFakeTimers().setSystemTime(1_800_000_000_000);
	chat.focusedId = requestId;
	vi.advanceTimersByTime(5000);
	chat.attempt = {
		action: 'analyze',
		requestId,
		images: [`uploads/${requestId}/receipt.png`],
		accountId: first.id
	};
	chat.phase = 'processing';
	chat.flush();
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!).startedAt).toBe(
		1_800_000_000_000
	);
});

it('keeps live created results unlocked without querying status', () => {
	chat.phase = 'created';
	expect(chat.readOnly).toBe(false);
	chat.phase = 'input';
	expect(chat.canCompose).toBe(true);
	expect(getSemanticEntryStatus).not.toHaveBeenCalled();
});

it('persists live image summaries as created so reload verifies completion', async () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.attempt = null;
	chat.conversation = [{ role: 'assistant', text: '已新增', expenses: [] }];
	chat.phase = 'input';
	chat.flush();
	expect(chat.canCompose).toBe(true);
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!).phase).toBe('created');
});

it('restores the full text clarification history and current question', () => {
	const history = [{ question: '金額？', answer: '100元' }];
	const clarification = {
		status: 'needs_input' as const,
		requestId,
		question: '日期？',
		issues: [{ field: 'date' as const, code: 'missing' as const }]
	};
	chat.attempt = { action: 'analyze', requestId, text: '午餐100', history, accountId: first.id };
	chat.history = history;
	chat.clarification = clarification;
	chat.question = clarification.question;
	chat.phase = 'needs_input';
	chat.conversation = [
		{ role: 'user', text: '午餐' },
		{ role: 'assistant', text: '金額？', answer: '100元' },
		{ role: 'user', text: '100元' }
	];
	chat.flush();
	const raw = storage.getItem(conversationKey(first.id))!;
	expect(JSON.parse(raw).question).toBe('日期？');
	user.set(null);
	storage.setItem(conversationKey(first.id), raw);
	user.set(first);
	expect(chat.history).toEqual(history);
	expect(chat.attempt?.history).toEqual(history);
	expect(chat.question).toBe('日期？');
	expect(chat.clarification).toEqual(clarification);
	expect(chat.canCompose).toBe(true);
	expect(getSemanticEntryStatus).not.toHaveBeenCalled();
});
