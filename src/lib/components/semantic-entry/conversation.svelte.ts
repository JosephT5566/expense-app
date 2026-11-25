import {
	conversationKey,
	parseConversation,
	loadConversation,
	saveConversation,
	removeConversation,
	type ConversationPhase,
	type ConversationTurn,
	type PersistedConversation
} from './persisted';
import { getSemanticEntryStatus } from '$lib/data/semantic-entry.fetcher';
import * as pending from './pending';
import { forceRefetchMonthlyExpenses } from '$lib/data/expenses.fetcher';
import { getTaiwanMonthKey } from '$lib/utils/dates';
import { SvelteMap } from 'svelte/reactivity';
import { browser } from '$app/environment';
import { fromStore } from 'svelte/store';
import { user } from '$lib/stores/session.store';
import { expenseOptions } from '$lib/stores/categories.store';
import { allowedUsers } from '$lib/stores/appSetting.store';
import { effectiveDrafts, isComplete, type DraftSession } from './drafts';
import { toISODateOnly } from '$lib/utils/dates';
import type { ExpenseRow } from '$lib/types/expense';
import type { PendingItem } from './pending';
import type {
	DraftIssue,
	SemanticResponseV3,
	SemanticRequestV3,
	ClarificationTurn,
	IssueV3
} from '@jopie/semantic-entry-contract';
const currentUser = fromStore(user);
const categories = fromStore(expenseOptions);
const members = fromStore(allowedUsers);
// Blob URLs and local files are runtime-only; turns contain preview IDs.
export const imagePreviews = new SvelteMap<string, string>();
export const attempts = new SvelteMap<string, SemanticRequestV3 & { accountId: string }>();
let text = $state('');
let session = $state<DraftSession | null>(null);
let draftEditorRequested = $state(false);
let today = $state(toISODateOnly(new Date(Date.now() + 8 * 60 * 60 * 1000)));
function refreshToday() {
	today = toISODateOnly(new Date(Date.now() + 8 * 60 * 60 * 1000));
}
let revised = $state(false);
let draftHeading = $state('');
let draftAnalysis = $state('');
let draftRejected = $state(false);
let serverDraftIssues = $state<Record<string, DraftIssue[]>>({});
const draftContext = $derived({
	today,
	categoryIds: new Set(categories.current.map((option) => option.value)),
	allowedEmails: members.current,
	currentUserEmail: currentUser.current?.email ?? ''
});
const drafts = $derived(
	session
		? effectiveDrafts(session, draftContext).map((draft) =>
				serverDraftIssues[draft.draftId] &&
				!draft.mergedFrom?.length &&
				!session?.items.find((item) => item.id === draft.draftId)?.edited
					? {
							...draft,
							issues: serverDraftIssues[draft.draftId],
							status: 'incomplete' as const
						}
					: draft
			)
		: []
);
let phase = $state<ConversationPhase>('input');
let attempt = $state<(SemanticRequestV3 & { accountId: string }) | null>(null);
let history = $state<ClarificationTurn[]>([]);
let question = $state('');
let clarification = $state<Extract<SemanticResponseV3, { status: 'needs_input' }> | null>(null);
let selectedOption = $state('');
const optionQuestion = $derived(phase === 'needs_input' && !!clarification?.options?.length);
let reply = $state('');
let focusedId = $state<string | null>(null);
let pendingItems = $state<PendingItem[]>([]);
let failedAttempt: (SemanticRequestV3 & { accountId: string }) | null = null;
let retainedCommit: (SemanticRequestV3 & { accountId: string }) | null = null;
let seenPersisting = false;
let recovering = false;
const lookingUp = new SvelteMap<string, 'query' | 'delete' | 'auto'>();
const lookupErrors = new SvelteMap<string, string>();
let lookupControllers: AbortController[] = [];
let lookupEpoch = 0;
let savedExpense = $state<ExpenseRow | null>(null);
const processing = $derived(phase === 'processing' || phase === 'persisting');
let issues = $state<IssueV3[]>([]);
let message = $state('');
let analysis = $state('');
let conversation = $state<(ConversationTurn & { imageIds?: string[] })[]>([]);
let conversationId = $state<string | null>(null);
let persistedBase: PersistedConversation | null = null;
let persistenceInvalidated = false;
let startedAt = $state<number | null>(null);
let lastPayload = $state<SemanticRequestV3 | null>(null);
let lastRequestId = $state<string | null>(null);
let completed = $state(false);
let checking = $state(false);
let resendAvailable = $state(false);
let restoredRequestId = $state<string | null>(null);
const readOnly = $derived(completed || checking);
let selectedImages = $state<{ file: File; url: string }[]>([]);
let imageError = $state('');
let converting = $state(false);
let uploading = $state(false);
let revision = 0;
let controller: AbortController | undefined;
let accountId = $state<string | undefined>();
const count = $derived([...text.trim()].length);
const replyCount = $derived([...reply.trim()].length);
const composingReply = $derived(phase === 'needs_input');
const canCompose = $derived(
	!readOnly &&
		(phase === 'input' ||
			phase === 'drafts' ||
			phase === 'uncertain' ||
			(composingReply && clarification?.allowFreeText !== false))
);
const attachmentsDisabled = $derived(
	!canCompose || !!session || composingReply || converting || selectedImages.length >= 4
);
const composerCount = $derived(composingReply ? replyCount : count);
const composerHint = $derived(
	readOnly
		? checking
			? '正在查詢先前請求結果。'
			: '已完成，請開新對話'
		: composerCount > 500 && canCompose
			? '訊息最多 500 字，請縮短後再送出。'
			: {
					drafts: text.trim()
						? '補充只更新草稿，不會重新讀取圖片。'
						: drafts.length > 0 && drafts.every(isComplete)
							? '可以繼續補充，或按「全部記帳」。'
							: revised
								? '可以繼續打字補充，或按「進入編輯」。'
								: '可以直接打字補充，例如「第三筆是午餐」。',
					input: '資訊完整後會直接記帳；多筆或不完整時會先列出草稿。',
					needs_input: attempt?.referenceDate
						? `本次「今天」固定為 ${attempt.referenceDate}（台灣日期）。日期更正請填完整年月日。`
						: '補充這筆支出的資訊，接續剛才的對話。',
					processing: '正在解析，請等待助手回覆。',
					persisting: '正在儲存這筆支出，請稍候。',
					created: '已完成記帳，點選「新增另一筆」開始新對話。',
					rejected: '請修改內容後重新送出。',
					error: '請查看助手訊息，再修改內容或稍後重試。',
					uncertain: '請先查詢結果或重試同一請求，避免重複記帳。'
				}[phase]
);
export const chat = {
	get readOnly() {
		return readOnly;
	},
	get completed() {
		return completed;
	},
	get checking() {
		return checking;
	},
	get resendAvailable() {
		return resendAvailable;
	},
	get restoredRequestId() {
		return restoredRequestId;
	},
	get lastRequestId() {
		return lastRequestId;
	},
	lookupRestored,
	flush: persistCurrent,
	clearPersisted() {
		if (accountId) {
			try {
				removeConversation(accountId);
			} catch {
				/* Storage unavailable. */
			}
		}
		restoredRequestId = null;
		startedAt = null;
		conversationId = null;
		persistedBase = null;
		persistenceInvalidated = false;
		lastPayload = null;
		lastRequestId = null;
		completed = false;
		resendAvailable = false;
		checking = false;
	},
	refreshToday,
	get draftEditorRequested() {
		return draftEditorRequested;
	},
	set draftEditorRequested(value: boolean) {
		draftEditorRequested = value;
	},
	get text() {
		return text;
	},
	set text(value: typeof text) {
		text = value;
	},
	get session() {
		return session;
	},
	set session(value: typeof session) {
		session = value;
	},
	get revised() {
		return revised;
	},
	set revised(value: typeof revised) {
		revised = value;
	},
	get draftHeading() {
		return draftHeading;
	},
	set draftHeading(value: typeof draftHeading) {
		draftHeading = value;
	},
	get draftAnalysis() {
		return draftAnalysis;
	},
	set draftAnalysis(value: typeof draftAnalysis) {
		draftAnalysis = value;
	},
	get draftRejected() {
		return draftRejected;
	},
	set draftRejected(value: typeof draftRejected) {
		draftRejected = value;
	},
	get serverDraftIssues() {
		return serverDraftIssues;
	},
	set serverDraftIssues(value: typeof serverDraftIssues) {
		serverDraftIssues = value;
	},
	get draftContext() {
		return draftContext;
	},
	get drafts() {
		return drafts;
	},
	get phase() {
		return phase;
	},
	set phase(value: typeof phase) {
		phase = value;
	},
	get attempt() {
		return attempt;
	},
	set attempt(value: typeof attempt) {
		attempt = value;
		if (value) {
			startedAt ??= Date.now();
			conversationId ??= crypto.randomUUID();
			lastPayload = value;
			lastRequestId = value.requestId;
			resendAvailable = false;
		}
	},
	get history() {
		return history;
	},
	set history(value: typeof history) {
		history = value;
	},
	get question() {
		return question;
	},
	set question(value: typeof question) {
		question = value;
	},
	get clarification() {
		return clarification;
	},
	set clarification(value: typeof clarification) {
		clarification = value;
	},
	get selectedOption() {
		return selectedOption;
	},
	set selectedOption(value: typeof selectedOption) {
		selectedOption = value;
	},
	get optionQuestion() {
		return optionQuestion;
	},
	get reply() {
		return reply;
	},
	set reply(value: typeof reply) {
		reply = value;
	},
	get focusedId() {
		return focusedId;
	},
	set focusedId(value: typeof focusedId) {
		focusedId = value;
		if (value) {
			startedAt ??= Date.now();
			conversationId ??= crypto.randomUUID();
		}
	},
	get pendingItems() {
		return pendingItems;
	},
	set pendingItems(value: typeof pendingItems) {
		pendingItems = value;
	},
	get failedAttempt() {
		return failedAttempt;
	},
	set failedAttempt(value: typeof failedAttempt) {
		failedAttempt = value;
	},
	get retainedCommit() {
		return retainedCommit;
	},
	set retainedCommit(value: typeof retainedCommit) {
		retainedCommit = value;
	},
	get seenPersisting() {
		return seenPersisting;
	},
	set seenPersisting(value: typeof seenPersisting) {
		seenPersisting = value;
	},
	get recovering() {
		return recovering;
	},
	set recovering(value: typeof recovering) {
		recovering = value;
	},
	get lookingUp() {
		return lookingUp;
	},
	get lookupErrors() {
		return lookupErrors;
	},
	get lookupControllers() {
		return lookupControllers;
	},
	set lookupControllers(value: typeof lookupControllers) {
		lookupControllers = value;
	},
	get lookupEpoch() {
		return lookupEpoch;
	},
	set lookupEpoch(value: typeof lookupEpoch) {
		lookupEpoch = value;
	},
	get savedExpense() {
		return savedExpense;
	},
	set savedExpense(value: typeof savedExpense) {
		savedExpense = value;
	},
	get processing() {
		return processing;
	},
	get issues() {
		return issues;
	},
	set issues(value: typeof issues) {
		issues = value;
	},
	get message() {
		return message;
	},
	set message(value: typeof message) {
		message = value;
	},
	get analysis() {
		return analysis;
	},
	set analysis(value: typeof analysis) {
		analysis = value;
	},
	get conversation() {
		return conversation;
	},
	set conversation(value: typeof conversation) {
		conversation = value;
	},
	get selectedImages() {
		return selectedImages;
	},
	set selectedImages(value: typeof selectedImages) {
		selectedImages = value;
	},
	get imageError() {
		return imageError;
	},
	set imageError(value: typeof imageError) {
		imageError = value;
	},
	get converting() {
		return converting;
	},
	set converting(value: typeof converting) {
		converting = value;
	},
	get uploading() {
		return uploading;
	},
	set uploading(value: typeof uploading) {
		uploading = value;
	},
	get revision() {
		return revision;
	},
	set revision(value: typeof revision) {
		revision = value;
	},
	get controller() {
		return controller;
	},
	set controller(value: typeof controller) {
		controller = value;
	},
	get accountId() {
		return accountId;
	},
	set accountId(value: typeof accountId) {
		accountId = value;
	},
	get count() {
		return count;
	},
	get replyCount() {
		return replyCount;
	},
	get composingReply() {
		return composingReply;
	},
	get canCompose() {
		return canCompose;
	},
	get attachmentsDisabled() {
		return attachmentsDisabled;
	},
	get composerCount() {
		return composerCount;
	},
	get composerHint() {
		return composerHint;
	}
};

function resetAccount(next: string | undefined, removePrevious = true) {
	revision++;
	controller?.abort();
	lookupEpoch++;
	lookupControllers.forEach((controller) => controller.abort());
	lookupControllers = [];
	lookingUp.clear();
	lookupErrors.clear();
	for (const [id, retained] of attempts) {
		if (retained.accountId !== next) {
			attempts.delete(id);
		}
	}
	imagePreviews.forEach((url) => URL.revokeObjectURL(url));
	imagePreviews.clear();
	selectedImages.forEach((image) => URL.revokeObjectURL(image.url));
	if (removePrevious && accountId) {
		try {
			removeConversation(accountId);
		} catch {
			/* Storage unavailable. */
		}
	}
	restoredRequestId = null;
	startedAt = null;
	conversationId = null;
	persistedBase = null;
	persistenceInvalidated = false;
	lastPayload = null;
	lastRequestId = null;
	completed = false;
	checking = false;
	resendAvailable = false;
	accountId = next;
	text = '';
	session = null;
	draftEditorRequested = false;
	refreshToday();
	revised = false;
	draftHeading = '';
	draftAnalysis = '';
	draftRejected = false;
	serverDraftIssues = {};
	phase = 'input';
	attempt = null;
	history = [];
	question = '';
	clarification = null;
	selectedOption = '';
	reply = '';
	focusedId = null;
	pendingItems = [];
	failedAttempt = null;
	retainedCommit = null;
	seenPersisting = false;
	recovering = false;
	savedExpense = null;
	issues = [];
	message = '';
	analysis = '';
	conversation = [];
	selectedImages = [];
	imageError = '';
	converting = false;
	uploading = false;
	controller = undefined;
	if (next) {
		restoreConversation(next);
	}
}

// Account cleanup also runs while the chat page is unmounted.
if (browser) {
	user.subscribe((value) => {
		const next = value?.id;
		if (next !== accountId) {
			resetAccount(next);
		}
	});
	$effect.root(() => {
		$effect(() => {
			const snapshot = snapshotConversation();
			const owner = accountId;
			const timer = setTimeout(() => {
				if (
					owner &&
					owner === accountId &&
					snapshot &&
					!persistenceInvalidated &&
					snapshot.conversationId === conversationId
				) {
					persistSnapshot(owner, snapshot);
				}
			}, 100);
			return () => clearTimeout(timer);
		});
	});
	if (typeof window !== 'undefined') {
		window.addEventListener('pagehide', () => {
			persistCurrent();
			revision++;
			lookupEpoch++;
			controller?.abort();
			lookupControllers.forEach((controller) => controller.abort());
			analysis = '';
		});
		window.addEventListener('storage', (event) => {
			if (!accountId || (event.key !== conversationKey(accountId) && event.key !== null)) {
				return;
			}
			if (processing || uploading || converting || checking || lookingUp.size > 0) {
				persistenceInvalidated = true;
			} else {
				resetAccount(accountId, false);
			}
		});
	}
}

function snapshotConversation(): PersistedConversation | null {
	if (startedAt === null || !conversationId || uploading || checking || !lastPayload) {
		return null;
	}
	return {
		v: 1,
		conversationId,
		revision: persistedBase?.revision ?? 0,
		startedAt,
		updatedAt: Date.now(),
		completed,
		phase:
			phase === 'input' && pendingItems.some((item) => item.requestId === lastRequestId)
				? 'uncertain'
				: phase === 'input' && conversation.at(-1)?.expenses
					? 'created'
					: phase,
		requestId: lastRequestId,
		payload: lastPayload,
		conversation: $state.snapshot(conversation),
		history: $state.snapshot(history),
		clarification: $state.snapshot(clarification),
		session: session
			? $state.snapshot({
					...session,
					items: session.items.map((item) =>
						serverDraftIssues[item.id] && !item.edited
							? {
									...item,
									draft: {
										...item.draft,
										issues: serverDraftIssues[item.id],
										status: 'incomplete' as const
									}
								}
							: item
					)
				})
			: null,
		text,
		question,
		message,
		analysis: '',
		draftHeading,
		draftAnalysis,
		draftRejected,
		revised
	};
}
function persistCurrent() {
	if (!accountId || persistenceInvalidated) {
		return;
	}
	const snapshot = snapshotConversation();
	if (snapshot) {
		persistSnapshot(accountId, snapshot);
	}
}
function persistSnapshot(owner: string, snapshot: PersistedConversation) {
	const clean = parseConversation(snapshot, Date.now());
	if (!clean) {
		return;
	}
	// Restoring unchanged state must not start a storage-event write loop between tabs.
	const content = (value: PersistedConversation) =>
		JSON.stringify({ ...value, updatedAt: 0, revision: 0 });
	if (persistedBase && content(clean) === content(persistedBase)) {
		return;
	}
	try {
		const saved = saveConversation(owner, clean, globalThis.localStorage, persistedBase);
		if (saved) {
			persistedBase = saved;
		}
	} catch {
		/* Storage unavailable. */
	}
}

function restoreConversation(owner: string) {
	let saved;
	try {
		saved = loadConversation(owner, Date.now());
	} catch {
		return;
	}
	if (!saved) {
		return;
	}
	persistedBase = saved;
	conversationId = saved.conversationId;
	startedAt = saved.startedAt;
	lastPayload = saved.payload;
	lastRequestId = saved.requestId;
	restoredRequestId = saved.requestId;
	conversation = saved.conversation;
	history = saved.history;
	clarification = saved.clarification;
	session = saved.session;
	text = saved.text;
	question = saved.question;
	message = saved.message;
	analysis = saved.analysis;
	draftHeading = saved.draftHeading;
	draftAnalysis = saved.draftAnalysis;
	draftRejected = saved.draftRejected;
	revised = saved.revised;
	phase = saved.phase;
	// A stored completion flag is a hint to query, never authority to mark completion.
	if (saved.payload) {
		attempt = { ...saved.payload, accountId: owner };
		attempts.set(saved.payload.requestId, attempt);
	}
	if (
		saved.completed ||
		['processing', 'persisting', 'uncertain', 'created'].includes(saved.phase)
	) {
		focusedId = saved.requestId;
		phase = 'uncertain';
		void lookupRestored();
	}
}
async function lookupRestored() {
	const owner = accountId;
	const id = lastRequestId;
	const epoch = lookupEpoch;
	if (!owner || !id || checking || completed) {
		return;
	}
	const current = () => accountId === owner && lookupEpoch === epoch && lastRequestId === id;
	const requestController = new AbortController();
	lookupControllers.push(requestController);
	checking = true;
	resendAvailable = false;
	try {
		const result = await getSemanticEntryStatus(id, requestController.signal);
		if (!current()) {
			return;
		}
		if (result) {
			completed = true;
			phase = 'created';
			session = null;
			clarification = null;
			analysis = '';
			conversation = conversation.filter(
				(turn) => !turn.drafts && !(turn.expenses && turn.requestId === id)
			);
			conversation.push({
				role: 'assistant',
				text: '已完成，請開新對話',
				requestId: id,
				expenses: result.expenses
			});
			message = '';
			savedExpense = null;
			attempt = null;
			focusedId = null;
			attempts.delete(id);
			try {
				pendingItems = pending.remove(owner, id);
			} catch {
				/* Retry storage on next load. */
			}
			persistCurrent();
			for (const month of new Set(result.expenses.map((row) => getTaiwanMonthKey(row.ts)))) {
				await forceRefetchMonthlyExpenses(month, undefined, current);
				if (!current()) {
					return;
				}
			}
		} else {
			phase = 'uncertain';
			message = '這筆請求沒有完成，可重新送出';
			resendAvailable = !!lastPayload;
			const items = pending.load(owner, Date.now());
			const item = items.find((item) => item.requestId === id);
			pendingItems =
				item && pending.isPastWindow(item, Date.now())
					? pending.markExpired(owner, id, Date.now())
					: items;
		}
	} catch {
		if (current() && !completed) {
			phase = 'uncertain';
			message = '無法查詢結果，請稍後再按「查詢結果」。';
		}
	} finally {
		lookupControllers = lookupControllers.filter((entry) => entry !== requestController);
		if (current()) {
			checking = false;
			persistCurrent();
		}
	}
}
