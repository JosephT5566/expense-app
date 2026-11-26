import {
	object,
	parseRequestV3,
	parseResponseV3,
	parseDraftV3,
	parseExpenseRow,
	type SemanticRequestV3,
	type SemanticResponseV3,
	type ClarificationTurn,
	type ExpenseRow
} from '@jopie/semantic-entry-contract';
import { toClientDraft, type DraftSession } from './drafts';
export const CONVERSATION_TTL_MS = 86_400_000;
export const conversationKey = (owner: string) => `jopie:semantic-conversation:${owner}`;
type ConversationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ConversationPhase =
	| 'input'
	| 'drafts'
	| 'needs_input'
	| 'processing'
	| 'persisting'
	| 'created'
	| 'rejected'
	| 'uncertain'
	| 'error';
export type ConversationTurn = {
	role: 'user' | 'assistant';
	requestId?: string;
	text: string;
	analysis?: string;
	imageCount?: number;
	imagePaths?: string[];
	expenses?: ExpenseRow[];
	drafts?: boolean;
	answer?: string;
	options?: { id: string; label: string }[];
	optionId?: string;
};
export type PersistedConversation = {
	v: 1;
	conversationId: string;
	revision: number;
	startedAt: number;
	updatedAt: number;
	completed: boolean;
	phase: ConversationPhase;
	requestId: string | null;
	payload: SemanticRequestV3 | null;
	conversation: ConversationTurn[];
	history: ClarificationTurn[];
	clarification: Extract<SemanticResponseV3, { status: 'needs_input' }> | null;
	session: DraftSession | null;
	text: string;
	question: string;
	message: string;
	analysis: string;
	draftHeading: string;
	draftAnalysis: string;
	draftRejected: boolean;
	revised: boolean;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function str(value: unknown): string {
	if (typeof value !== 'string') {
		throw new Error('Invalid string');
	}
	return value;
}
function bool(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw new Error('Invalid boolean');
	}
	return value;
}
function count(value: unknown): number {
	const n = num(value);
	if (!Number.isSafeInteger(n)) {
		throw new Error('Invalid count');
	}
	return n;
}
function num(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error('Invalid number');
	}
	return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value)) {
		throw new Error('Invalid list');
	}
	return value.map(parse);
}
function pick(value: unknown, keys: string[]) {
	const r = object(value);
	return Object.fromEntries(
		keys.filter((key) => Object.hasOwn(r, key)).map((key) => [key, r[key]])
	);
}
function turnHistory(value: unknown): ClarificationTurn {
	const r = object(value);
	return {
		question: str(r.question),
		answer: str(r.answer),
		...('questionId' in r ? { questionId: str(r.questionId) } : {}),
		...('optionId' in r ? { optionId: str(r.optionId) } : {})
	};
}
function option(value: unknown) {
	const r = object(value);
	return { id: str(r.id), label: str(r.label) };
}
function path(value: unknown) {
	const s = str(value);
	if (!/^uploads\/[0-9a-f-]{36}\/[a-zA-Z0-9._/-]+$/.test(s) || s.includes('..')) {
		throw new Error('Invalid image path');
	}
	return s;
}
function draft(value: unknown) {
	const r = pick(value, [
		'draftId',
		'mergedFrom',
		'note',
		'amount',
		'originalAmount',
		'currency',
		'date',
		'categoryId',
		'scope',
		'payerEmail',
		'splitMemberEmails',
		'shares',
		'status',
		'issues',
		'updated'
	]);
	for (const key of [
		'note',
		'amount',
		'currency',
		'date',
		'categoryId',
		'scope',
		'payerEmail',
		'splitMemberEmails'
	]) {
		r[key] = pick(r[key], [
			'value',
			'state',
			'confidence',
			'source',
			...(key === 'date' ? ['defaulted'] : [])
		]);
	}
	r.issues = list(r.issues, (i) => pick(i, ['field', 'code']));
	if (r.originalAmount != null) {
		r.originalAmount = pick(r.originalAmount, ['text', 'currency']);
	}
	// Local edits may be incomplete (including zero amounts); validate the field shape
	// with a null amount, then retain the finite editable amount without recalculating shares.
	const amount = object(r.amount);
	const amountValue = amount.value;
	if (amountValue !== null) {
		count(amountValue);
	}
	if (amount.state === 'explicit_null' && amountValue !== null) {
		throw new Error('Invalid explicit null');
	}
	const parsed = parseDraftV3({ ...r, amount: { ...amount, value: null } });
	return {
		...parsed,
		amount: {
			...parsed.amount,
			value: amountValue === null ? null : num(amountValue)
		}
	};
}
function payload(value: unknown): SemanticRequestV3 {
	const r = pick(value, [
		'action',
		'requestId',
		'referenceDate',
		'text',
		'images',
		'history',
		'drafts',
		'conversationStartedAt'
	]);
	if ('history' in r) {
		r.history = list(r.history, turnHistory);
	}
	if ('images' in r) {
		r.images = list(r.images, path);
	}
	if ('drafts' in r) {
		r.drafts = list(r.drafts, (d) => {
			const clean = draft({ status: 'complete', issues: [], ...object(d) });
			return toClientDraft(clean);
		});
	}
	return parseRequestV3(r);
}
export function parseConversation(raw: unknown, now: number): PersistedConversation | null {
	try {
		const r = object(raw);
		if (
			r.v !== 1 ||
			now < num(r.startedAt) ||
			now - num(r.startedAt) >= CONVERSATION_TTL_MS ||
			num(r.updatedAt) < num(r.startedAt) ||
			num(r.updatedAt) > now
		) {
			return null;
		}
		const conversationId = str(r.conversationId);
		if (!uuid.test(conversationId)) {
			return null;
		}
		const phase = r.phase;
		if (
			phase !== 'input' &&
			phase !== 'drafts' &&
			phase !== 'needs_input' &&
			phase !== 'processing' &&
			phase !== 'persisting' &&
			phase !== 'created' &&
			phase !== 'rejected' &&
			phase !== 'uncertain' &&
			phase !== 'error'
		) {
			return null;
		}
		const requestId = r.requestId === null ? null : str(r.requestId);
		if (requestId !== null && !uuid.test(requestId)) {
			return null;
		}
		let rawPayload = r.payload;
		if (rawPayload !== null) {
			const stored = object(rawPayload);
			if (
				!Object.hasOwn(stored, 'conversationStartedAt') &&
				Array.isArray(stored.history) &&
				stored.history.length
			) {
				rawPayload = {
					...stored,
					conversationStartedAt: new Date(num(r.startedAt)).toISOString()
				};
			}
		}
		const request = rawPayload === null ? null : payload(rawPayload);
		if (!request || !requestId) {
			return null;
		}
		if (request && request.requestId !== requestId) {
			return null;
		}
		const clarification =
			r.clarification === null
				? null
				: pick(r.clarification, [
						'status',
						'requestId',
						'question',
						'issues',
						'questionId',
						'purpose',
						'options',
						'allowFreeText'
					]);
		if (clarification) {
			clarification.issues = list(clarification.issues, (issue) =>
				pick(issue, ['field', 'code'])
			);
			if ('options' in clarification) {
				clarification.options = list(clarification.options, option);
			}
		}
		const response = clarification === null ? null : parseResponseV3(clarification);
		if (response && (response.status !== 'needs_input' || response.requestId !== requestId)) {
			return null;
		}
		const session = r.session === null ? null : object(r.session);
		const parsedSession: DraftSession | null = session
			? {
					items: list(session.items, (value) => {
						const i = object(value);
						const id = str(i.id);
						if (!uuid.test(id)) {
							throw new Error('Invalid id');
						}
						return {
							id,
							draft: draft(i.draft),
							hidden: bool(i.hidden),
							edited: bool(i.edited),
							...('groupId' in i ? { groupId: count(i.groupId) } : {})
						};
					}),
					groupSummaries: Object.fromEntries(
						Object.entries(object(session.groupSummaries)).map(([key, value]) => {
							if (!/^\d+$/.test(key)) {
								throw new Error('Invalid group');
							}
							return [key, draft(value)];
						})
					)
				}
			: null;
		if (
			(phase === 'needs_input' && (!response || !request)) ||
			(phase === 'drafts' && !parsedSession)
		) {
			return null;
		}
		return {
			v: 1,
			conversationId,
			revision: count(r.revision),
			startedAt: num(r.startedAt),
			updatedAt: num(r.updatedAt),
			completed: bool(r.completed),
			phase,
			requestId,
			payload: request,
			session: parsedSession,
			conversation: list(r.conversation, (value) => {
				const t = object(value);
				if ('imageCount' in t && count(t.imageCount) > 4) {
					throw new Error('Invalid image count');
				}
				if (t.role !== 'user' && t.role !== 'assistant') {
					throw new Error('Invalid role');
				}
				if ('requestId' in t && !uuid.test(str(t.requestId))) {
					throw new Error('Invalid result request id');
				}
				return {
					...('requestId' in t ? { requestId: str(t.requestId) } : {}),
					role: t.role,
					text: str(t.text),
					...('analysis' in t ? { analysis: str(t.analysis) } : {}),
					...('imageCount' in t ? { imageCount: count(t.imageCount) } : {}),
					...('imagePaths' in t ? { imagePaths: list(t.imagePaths, path) } : {}),
					...('expenses' in t
						? {
								expenses: list(t.expenses, (value) =>
									parseExpenseRow(
										pick(value, [
											'id',
											'payer_email',
											'note',
											'amount',
											'currency',
											'ts',
											'scope',
											'shares_json',
											'meta',
											'created_at',
											'updated_at',
											'is_settled',
											'notes',
											'category_id'
										])
									)
								)
							}
						: {}),
					...('drafts' in t ? { drafts: bool(t.drafts) } : {}),
					...('answer' in t ? { answer: str(t.answer) } : {}),
					...('options' in t ? { options: list(t.options, option) } : {}),
					...('optionId' in t ? { optionId: str(t.optionId) } : {})
				};
			}),
			history:
				parseRequestV3({
					action: 'analyze',
					requestId,
					text: 'history',
					history: list(r.history, turnHistory),
					conversationStartedAt: new Date(num(r.startedAt)).toISOString()
				}).history ?? [],
			clarification: response?.status === 'needs_input' ? response : null,
			text: str(r.text),
			question: str(r.question),
			message: str(r.message),
			analysis: '',
			draftHeading: str(r.draftHeading),
			draftAnalysis: phase === 'drafts' ? str(r.draftAnalysis) : '',
			draftRejected: bool(r.draftRejected),
			revised: bool(r.revised)
		};
	} catch {
		return null;
	}
}
export function removeConversation(
	owner: string,
	storage: ConversationStorage = globalThis.localStorage
) {
	storage.removeItem(conversationKey(owner));
}
export function loadConversation(
	owner: string,
	now: number,
	storage: ConversationStorage = globalThis.localStorage
) {
	const raw = storage.getItem(conversationKey(owner));
	if (raw === null) {
		return null;
	}
	let parsed = null;
	try {
		parsed = parseConversation(JSON.parse(raw), now);
	} catch {
		/* Invalid JSON is discarded. */
	}
	if (!parsed && storage.getItem(conversationKey(owner)) === raw) {
		removeConversation(owner, storage);
	}
	return parsed;
}
export function saveConversation(
	owner: string,
	value: PersistedConversation,
	storage: ConversationStorage = globalThis.localStorage,
	expected?: Pick<PersistedConversation, 'conversationId' | 'revision'> | null
): PersistedConversation | null {
	const key = conversationKey(owner);
	const raw = storage.getItem(key);
	let stored = null;
	try {
		stored = raw === null ? null : parseConversation(JSON.parse(raw), Date.now());
	} catch {
		/* Malformed storage cannot authorize an existing tab to overwrite it. */
	}
	if (
		expected !== undefined &&
		(expected === null
			? raw !== null
			: !stored ||
				stored.conversationId !== expected.conversationId ||
				stored.revision !== expected.revision)
	) {
		return null;
	}
	const clean = parseConversation(value, Date.now());
	if (!clean) {
		if (
			stored?.conversationId === value.conversationId &&
			stored.revision === value.revision &&
			storage.getItem(key) === raw
		) {
			storage.removeItem(key);
		}
		return null;
	}
	clean.revision =
		(stored?.conversationId === clean.conversationId ? stored.revision : clean.revision) + 1;
	storage.setItem(key, JSON.stringify(clean));
	return clean;
}
// #84 will supply signed GET URLs. Object paths are never used as image URLs.
export function restoredImageUrl(path: string): null {
	void path;
	return null;
}
