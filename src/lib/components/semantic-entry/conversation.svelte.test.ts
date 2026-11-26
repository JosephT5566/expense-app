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
	vi.stubGlobal('window', new EventTarget());
	return storage;
});
vi.mock('$lib/data/semantic-entry.fetcher', () => ({ getSemanticEntryStatus: vi.fn() }));
vi.mock('$lib/data/expenses.fetcher', () => ({
	forceRefetchMonthlyExpenses: vi.fn().mockResolvedValue(true)
}));
import { getSemanticEntryStatus } from '$lib/data/semantic-entry.fetcher';
import {
	saveConversation,
	loadConversation,
	listConversations,
	conversationKey,
	type PersistedConversation
} from './persisted';
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
		conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
		revision: 0,
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
	expect(chat.text).toBe('');
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
	chat.reply = '我付款';
	const url = URL.createObjectURL(new Blob(['synthetic']));
	chat.selectedImages = [{ file: new File(['synthetic'], 'receipt.png'), url }];
	const revoke = vi.spyOn(URL, 'revokeObjectURL');
	vi.mocked(getSemanticEntryStatus).mockResolvedValue({ expenses: [], replayed: true });
	await chat.lookupRestored();
	expect(chat.text).toBe('');
	expect(chat.reply).toBe('');
	expect(chat.selectedImages).toEqual([]);
	expect(revoke).toHaveBeenCalledWith(url);
	revoke.mockRestore();
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!)[0].text).toBe('');
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!)[0].payload).toEqual(
		saved().payload
	);
	expect(chat.completed).toBe(true);
	expect(chat.readOnly).toBe(true);
	expect(chat.canCompose).toBe(false);
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!)[0].completed).toBe(true);
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
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!)[0].startedAt).toBe(
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
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!)[0].phase).toBe('created');
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
	expect(JSON.parse(raw)[0].question).toBe('日期？');
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

it('keeps earlier completed results when the last request is verified after reload', async () => {
	user.set(null);
	const earlierId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
	const earlier = {
		role: 'assistant' as const,
		text: '第一筆',
		requestId: earlierId,
		expenses: []
	};
	saveConversation(
		first.id,
		{
			...saved('created'),
			conversation: [earlier, { role: 'assistant', text: '第二筆', requestId, expenses: [] }]
		},
		storage
	);
	vi.mocked(getSemanticEntryStatus).mockResolvedValue({ expenses: [], replayed: true });
	user.set(first);
	await vi.waitFor(() => expect(chat.completed).toBe(true));
	expect(chat.conversation).toHaveLength(2);
	expect(chat.conversation[0]).toEqual(earlier);
	expect(chat.conversation[1].requestId).toBe(requestId);
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!)[0].conversation).toHaveLength(2);
});

function storageChanged() {
	window.dispatchEvent(Object.assign(new Event('storage'), { key: conversationKey(first.id) }));
}
it('ignores another conversation saved by a tab and resets on deletion without resurrecting it', () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.phase = 'error';
	chat.flush();
	const replacement = {
		...saved('error'),
		conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
		text: 'other tab'
	};
	saveConversation(first.id, replacement, storage);
	storageChanged();
	expect(chat.text).toBe('');
	expect(listConversations(first.id, Date.now(), storage)).toHaveLength(2);
	const raw = storage.getItem(conversationKey(first.id));
	chat.flush();
	expect(storage.getItem(conversationKey(first.id))).toBe(raw);
	storage.removeItem(conversationKey(first.id));
	storageChanged();
	expect(chat.conversation).toEqual([]);
	chat.flush();
	expect(storage.getItem(conversationKey(first.id))).toBeNull();
});
it('does not overwrite a deletion while an in-flight tab waits for its response', () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.phase = 'processing';
	chat.flush();
	storage.removeItem(conversationKey(first.id));
	storageChanged();
	expect(chat.phase).toBe('processing');
	chat.phase = 'needs_input';
	chat.question = '金額？';
	chat.clarification = { status: 'needs_input', requestId, question: '金額？', issues: [] };
	chat.flush();
	expect(storage.getItem(conversationKey(first.id))).toBeNull();
});
it('flushes before pagehide clears analysis and invalidates interrupted callbacks', async () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.analysis = '暫時摘要';
	chat.phase = 'processing';
	chat.controller = new AbortController();
	const revision = chat.revision;
	window.dispatchEvent(new Event('pagehide'));
	expect(chat.analysis).toBe('');
	expect(chat.controller.signal.aborted).toBe(true);
	expect(chat.revision).toBeGreaterThan(revision);
	expect(storage.getItem(conversationKey(first.id))).not.toContain('暫時摘要');
});

it('ignores a lookup response delivered after pagehide', async () => {
	user.set(null);
	saveConversation(first.id, saved(), storage);
	let finish: (value: { expenses: []; replayed: true }) => void = () => {};
	vi.mocked(getSemanticEntryStatus).mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	user.set(first);
	expect(chat.checking).toBe(true);
	window.dispatchEvent(new Event('pagehide'));
	finish({ expenses: [], replayed: true });
	await Promise.resolve();
	expect(chat.completed).toBe(false);
	expect(chat.conversation).toEqual(saved().conversation);
});

it.each(['processing', 'persisting'] as const)(
	'persists an empty composer during %s while retaining the submitted payload and history',
	(phase: 'processing' | 'persisting') => {
		const payload = {
			action: 'analyze' as const,
			requestId,
			text: '午餐100',
			history: [{ question: '金額？', answer: '100元' }]
		};
		chat.attempt = { ...payload, accountId: first.id };
		chat.conversation = [
			{ role: 'user', text: '午餐100' },
			{ role: 'user', text: '100元' }
		];
		chat.text = '午餐100';
		chat.reply = '100元';
		chat.phase = phase;
		chat.flush();
		const snapshot = JSON.parse(storage.getItem(conversationKey(first.id))!)[0];
		expect(snapshot.text).toBe('');
		expect(snapshot).not.toHaveProperty('reply');
		expect(snapshot.payload).toMatchObject(payload);
		expect(snapshot.conversation).toEqual(chat.conversation);
	}
);

it('preserves rejected text for editing in the persisted composer', () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.text = '午餐100';
	chat.phase = 'rejected';
	chat.flush();
	expect(JSON.parse(storage.getItem(conversationKey(first.id))!)[0].text).toBe('午餐100');
});

it('keeps the previous submitted conversation when starting new, without adding empty entries', () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.conversation = saved().conversation;
	chat.phase = 'error';
	chat.clearPersisted();
	const previous = listConversations(first.id, Date.now(), storage)[0];
	expect(previous.summary).toBe('午餐100');
	chat.conversation = [];
	chat.text = '';
	chat.phase = 'input';
	chat.clearPersisted();
	expect(listConversations(first.id, Date.now(), storage)).toHaveLength(1);
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.conversation = [{ role: 'user', text: '晚餐200' }];
	chat.phase = 'error';
	chat.flush();
	expect(listConversations(first.id, Date.now(), storage)).toHaveLength(2);
	expect(loadConversation(first.id, Date.now(), storage, previous.id)?.conversation).toEqual(
		saved().conversation
	);
});

it('adopts an update to the same conversation from another idle tab', () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.phase = 'error';
	chat.flush();
	const base = loadConversation(first.id, Date.now(), storage)!;
	saveConversation(first.id, { ...base, text: 'updated in other tab' }, storage, base);
	storageChanged();
	expect(chat.text).toBe('updated in other tab');
	const raw = storage.getItem(conversationKey(first.id));
	chat.flush();
	expect(storage.getItem(conversationKey(first.id))).toBe(raw);
});

it('keeps a new unsaved conversation writable when another tab saves a different entry', () => {
	chat.attempt = { ...saved().payload!, accountId: first.id };
	chat.conversation = [{ role: 'user', text: 'new conversation' }];
	chat.phase = 'processing';
	saveConversation(first.id, saved('error'), storage, null);
	storageChanged();
	chat.phase = 'error';
	chat.flush();
	expect(listConversations(first.id, Date.now(), storage)).toHaveLength(2);
});

it('selects history only for the current owner while idle and retains the current record', () => {
	const old = saved('input');
	old.text = '';
	saveConversation(first.id, old, storage);
	expect(chat.selectConversation('other', old)).toBe(false);
	chat.phase = 'processing';
	expect(chat.selectConversation(first.id, old)).toBe(false);
	chat.phase = 'input';
	chat.converting = true;
	expect(chat.selectConversation(first.id, old)).toBe(false);
	chat.converting = false;
	expect(chat.selectConversation(first.id, old)).toBe(true);
	chat.conversation.push({ role: 'assistant', text: '保留補充' });
	const another = {
		...old,
		conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
		conversation: [{ role: 'user' as const, text: '晚餐' }]
	};
	saveConversation(first.id, another, storage);
	expect(chat.selectConversation(first.id, another)).toBe(true);
	expect(chat.conversation[0].text).toBe('晚餐');
	expect(
		loadConversation(first.id, Date.now(), storage, old.conversationId)?.conversation.at(-1)
			?.text
	).toBe('保留補充');
});

it.each(['created', 'expired', 'expired-processing'] as const)(
	'opens %s history read-only without a status request',
	(kind) => {
		const record = saved(kind === 'created' ? 'created' : 'input');
		if (kind === 'created') {
			saveConversation(first.id, record, storage);
		}
		if (kind !== 'created') {
			if (kind === 'expired-processing') {
				record.phase = 'processing';
			}
			record.startedAt -= 86_400_000;
		}
		expect(chat.selectConversation(first.id, record)).toBe(true);
		expect(chat.readOnly).toBe(true);
		expect(chat.text).toBe('');
		expect(chat.resendAvailable).toBe(false);
		expect(chat.switchingDisabled).toBe(false);
		expect(getSemanticEntryStatus).not.toHaveBeenCalled();
		chat.clearPersisted();
		expect(chat.readOnly).toBe(false);
	}
);
