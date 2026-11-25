import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { user } from '$lib/stores/session.store';

vi.mock('$app/environment', () => ({ browser: true }));

import { attempts, chat, imagePreviews } from './conversation.svelte';

afterEach(() => {
	vi.useRealTimers();
});

const first = { id: 'first-account', email: 'first@example.test' };
beforeEach(() => {
	user.set(null);
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
