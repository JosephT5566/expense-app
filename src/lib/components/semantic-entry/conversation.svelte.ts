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
let revised = $state(false);
let draftHeading = $state('');
let draftAnalysis = $state('');
let draftRejected = $state(false);
let serverDraftIssues = $state<Record<string, DraftIssue[]>>({});
const draftContext = $derived({
	today: toISODateOnly(new Date(Date.now() + 8 * 60 * 60 * 1000)),
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
let phase = $state<
	| 'input'
	| 'drafts'
	| 'needs_input'
	| 'processing'
	| 'persisting'
	| 'created'
	| 'rejected'
	| 'uncertain'
	| 'error'
>('input');
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
let conversation = $state<
	{
		role: 'user' | 'assistant';
		text: string;
		analysis?: string;
		imageIds?: string[];
		expenses?: ExpenseRow[];
		drafts?: boolean;
		answer?: string;
		options?: { id: string; label: string }[];
		optionId?: string;
	}[]
>([]);
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
	phase === 'input' ||
		phase === 'drafts' ||
		phase === 'uncertain' ||
		(composingReply && clarification?.allowFreeText !== false)
);
const attachmentsDisabled = $derived(
	!canCompose || !!session || composingReply || converting || selectedImages.length >= 4
);
const composerCount = $derived(composingReply ? replyCount : count);
const composerHint = $derived(
	composerCount > 500 && canCompose
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

// Account cleanup also runs while the chat page is unmounted.
if (browser) {
	user.subscribe((value) => {
		const next = value?.id;
		if (next === accountId) {
			return;
		}
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
		accountId = next;
		text = '';
		session = null;
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
	});
}
