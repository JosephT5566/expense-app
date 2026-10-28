import type { ExpenseRow } from '../../../src/lib/types/expense';
export type { ExpenseRow };
export interface ClarificationTurn {
	question: string;
	answer: string;
}
export interface SemanticRequest {
	requestId: string;
	text: string;
	history?: ClarificationTurn[];
	referenceDate?: string;
}
export interface SemanticContext {
	today: string;
	referenceDate?: string;
	currentUserEmail: string;
	members: { id: string; email: string; name: string }[];
	categories: { id: string; name: string }[];
}
export interface ModelExtraction {
	note: string | null;
	amount: number | null;
	currency: string | null;
	date: {
		kind: 'today' | 'yesterday' | 'day_before_yesterday' | 'absolute' | 'missing';
		value: string | null;
	};
	payerId: string | null;
	scope: 'personal' | 'household' | null;
	hasSharedIntent: boolean;
	splitMemberIds: string[] | null;
	categoryId: string | null;
	unsupportedReason: string | null;
}
export type IssueCode =
	| 'missing'
	| 'invalid'
	| 'unknown_member'
	| 'ambiguous_member'
	| 'unsupported'
	| 'configuration';
export interface Issue {
	field: string;
	code: IssueCode;
}
export interface ValidatedExpense {
	note: string;
	amount: number;
	currency: 'TWD';
	ts: string;
	payer_email: string;
	scope: 'personal' | 'household';
	shares_json: Record<string, number>;
	category_id: string;
	is_settled: boolean;
}
export type ValidationResult =
	| { status: 'valid'; expense: ValidatedExpense }
	| { status: 'rejected'; issues: Issue[] };
export interface Metadata {
	model: string;
	promptVersion: string;
	inputTokens: number | null;
	outputTokens: number | null;
	elapsedMs: number;
}
export interface CompletedResult {
	expense: ExpenseRow;
	replayed: boolean;
}
export type SemanticResponse =
	| ({ status: 'created'; requestId: string; metadata: Metadata } & CompletedResult)
	| { status: 'rejected'; requestId: string; issues: Issue[] }
	| { status: 'needs_input'; requestId: string; question: string; issues: Issue[] };
export type StatusResponse =
	| ({ status: 'completed'; requestId: string } & CompletedResult)
	| { status: 'not_found'; requestId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codes: IssueCode[] = [
	'missing',
	'invalid',
	'unknown_member',
	'ambiguous_member',
	'unsupported',
	'configuration'
];
export function object(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('Invalid object');
	}
	return raw as Record<string, unknown>;
}
export function exactKeys(
	raw: Record<string, unknown>,
	keys: string[],
	optional: string[] = []
): void {
	if (
		keys.some((key) => !Object.hasOwn(raw, key)) ||
		Object.keys(raw).some((key) => !keys.includes(key) && !optional.includes(key))
	) {
		throw new Error('Invalid keys');
	}
}
function string(raw: unknown): string {
	if (typeof raw !== 'string' || !raw.trim()) {
		throw new Error('Invalid string');
	}
	return raw;
}
function requestId(raw: unknown): string {
	const id = string(raw);
	if (!uuid.test(id)) {
		throw new Error('Invalid UUID');
	}
	return id;
}
function integer(raw: unknown, minimum = 0): number {
	if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum) {
		throw new Error('Invalid integer');
	}
	return raw;
}
function timestamp(raw: unknown): string {
	const s = string(raw);
	if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) {
		throw new Error('Invalid timestamp');
	}
	return s;
}
function boundedText(raw: unknown, maximum: number): string {
	const value = string(raw).trim();
	if ([...value].length > maximum) {
		throw new Error('Text too long');
	}
	return value.normalize('NFC');
}
export function parseRequest(raw: unknown): SemanticRequest {
	const r = object(raw);
	exactKeys(r, ['requestId', 'text'], ['history', 'referenceDate']);
	const parsed: SemanticRequest = {
		requestId: requestId(r.requestId),
		text: boundedText(r.text, 500)
	};
	if (Object.hasOwn(r, 'referenceDate')) {
		const value = string(r.referenceDate);
		const parsedDate = new Date(`${value}T00:00:00.000Z`);
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
			!Number.isFinite(parsedDate.getTime()) ||
			parsedDate.getUTCFullYear() < 100 ||
			parsedDate.toISOString().slice(0, 10) !== value
		) {
			throw new Error('Invalid reference date');
		}
		parsed.referenceDate = value;
	}
	if (Object.hasOwn(r, 'history')) {
		if (!Array.isArray(r.history) || r.history.length > 3) {
			throw new Error('Invalid history');
		}
		const history = r.history.map((raw): ClarificationTurn => {
			const turn = object(raw);
			exactKeys(turn, ['question', 'answer']);
			return {
				question: boundedText(turn.question, 300),
				answer: boundedText(turn.answer, 500)
			};
		});
		if (history.length) {
			parsed.history = history;
		}
	}
	return parsed;
}
export function parseExpenseRow(raw: unknown): ExpenseRow {
	const r = object(raw);
	exactKeys(
		r,
		[
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
			'is_settled'
		],
		['notes', 'category_id']
	);
	const shares = object(r.shares_json);
	if (
		!Object.keys(shares).length ||
		Object.entries(shares).some(([email, share]) => !email.includes('@') || integer(share) < 0)
	) {
		throw new Error('Invalid shares');
	}
	if (
		r.currency !== 'TWD' ||
		!['personal', 'household'].includes(String(r.scope)) ||
		typeof r.is_settled !== 'boolean' ||
		typeof r.meta !== 'string'
	) {
		throw new Error('Invalid expense');
	}
	requestId(r.id);
	string(r.note);
	string(r.payer_email);
	integer(r.amount, 1);
	if (Object.values(shares).reduce<number>((sum, share) => sum + Number(share), 0) !== r.amount) {
		throw new Error('Invalid share sum');
	}
	timestamp(r.ts);
	timestamp(r.created_at);
	timestamp(r.updated_at);
	if (r.notes !== undefined && typeof r.notes !== 'string') {
		throw new Error('Invalid notes');
	}
	if (r.category_id !== undefined && r.category_id !== null) {
		string(r.category_id);
	}
	return r as unknown as ExpenseRow;
}
export function parseCompletedResult(raw: unknown): CompletedResult {
	const r = object(raw);
	exactKeys(r, ['expense', 'replayed']);
	if (typeof r.replayed !== 'boolean') {
		throw new Error('Invalid replay flag');
	}
	return { expense: parseExpenseRow(r.expense), replayed: r.replayed };
}
export function parseResponse(raw: unknown): SemanticResponse {
	const r = object(raw);
	const id = requestId(r.requestId);
	if (r.status === 'rejected' || r.status === 'needs_input') {
		exactKeys(
			r,
			r.status === 'needs_input'
				? ['status', 'requestId', 'issues', 'question']
				: ['status', 'requestId', 'issues']
		);
		if (!Array.isArray(r.issues) || !r.issues.length) {
			throw new Error('Invalid issues');
		}
		const issues = r.issues.map((v): Issue => {
			const i = object(v);
			exactKeys(i, ['field', 'code']);
			string(i.field);
			if (!codes.includes(i.code as IssueCode)) {
				throw new Error('Invalid issue code');
			}
			return i as unknown as Issue;
		});
		return r.status === 'needs_input'
			? {
					status: 'needs_input',
					requestId: id,
					question: boundedText(r.question, 300),
					issues
				}
			: { status: 'rejected', requestId: id, issues };
	}
	if (r.status !== 'created') {
		throw new Error('Invalid status');
	}
	exactKeys(r, ['status', 'requestId', 'expense', 'replayed', 'metadata']);
	const m = object(r.metadata);
	exactKeys(m, ['model', 'promptVersion', 'inputTokens', 'outputTokens', 'elapsedMs']);
	string(m.model);
	string(m.promptVersion);
	integer(m.elapsedMs);
	for (const key of ['inputTokens', 'outputTokens']) {
		if (m[key] !== null) {
			integer(m[key]);
		}
	}
	return {
		status: 'created',
		requestId: id,
		...parseCompletedResult({ expense: r.expense, replayed: r.replayed }),
		metadata: m as unknown as Metadata
	};
}
export function parseStatusResponse(raw: unknown): StatusResponse {
	const r = object(raw);
	const id = requestId(r.requestId);
	if (r.status === 'not_found') {
		exactKeys(r, ['status', 'requestId']);
		return { status: 'not_found', requestId: id };
	}
	if (r.status !== 'completed') {
		throw new Error('Invalid status');
	}
	exactKeys(r, ['status', 'requestId', 'expense', 'replayed']);
	return {
		status: 'completed',
		requestId: id,
		...parseCompletedResult({ expense: r.expense, replayed: r.replayed })
	};
}

export type SemanticStreamEvent =
	| { type: 'analysis_delta'; requestId: string; seq: number; text: string }
	| { type: 'persisting'; requestId: string }
	| { type: 'result'; result: SemanticResponse }
	| { type: 'error'; code: string; uncertain: boolean };
export function parseStreamEvent(event: string, raw: unknown): SemanticStreamEvent {
	const r = object(raw);
	if (event === 'analysis_delta') {
		exactKeys(r, ['requestId', 'seq', 'text']);
		if (
			typeof r.text !== 'string' ||
			!r.text.length ||
			[...r.text].length > 200 ||
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(r.text)
		) {
			throw new Error('Invalid analysis');
		}
		return {
			type: 'analysis_delta',
			requestId: requestId(r.requestId),
			seq: integer(r.seq),
			text: r.text
		};
	}
	if (event === 'result') {
		return { type: 'result', result: parseResponse(raw) };
	}
	if (event === 'persisting') {
		exactKeys(r, ['status', 'requestId']);
		if (r.status !== 'persisting') {
			throw new Error('Invalid stream status');
		}
		return { type: 'persisting', requestId: requestId(r.requestId) };
	}
	if (event === 'error') {
		exactKeys(r, ['error']);
		const e = object(r.error);
		exactKeys(e, ['code', 'uncertain']);
		if (typeof e.uncertain !== 'boolean') {
			throw new Error('Invalid uncertainty');
		}
		return { type: 'error', code: string(e.code), uncertain: e.uncertain };
	}
	throw new Error('Unknown stream event');
}

// V3 is opt-in: legacy parsers and exports above retain their wire contract.
export const MAX_REQUEST_BYTES_V3 = 65536;
export const MAX_DRAFTS = 20;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_PATH_LENGTH = 1024;
export type FieldState = 'recognized' | 'unrecognized' | 'missing' | 'explicit_null';
export type FieldSource = 'image' | 'text' | 'default' | 'user';
export interface DraftField<T> {
	value: T | null;
	state: FieldState;
	confidence: number | null;
	source: FieldSource;
}
export interface Draft {
	draftId: string;
	mergedFrom?: string[];
	note: DraftField<string>;
	amount: DraftField<number>;
	originalAmount?: { text: string; currency: string } | null;
	currency: DraftField<string>;
	date: DraftField<string> & { defaulted: null | 'unreadable' | 'future' };
	categoryId: DraftField<string>;
	scope: DraftField<'personal' | 'household'>;
	payerEmail: DraftField<string>;
	splitMemberEmails: DraftField<string[]>;
	status: 'complete' | 'incomplete';
	issues: DraftIssue[];
	updated?: boolean;
}
const draftFields = [
	'note',
	'amount',
	'currency',
	'date',
	'categoryId',
	'scope',
	'payerEmail',
	'splitMemberEmails'
] as const;
export type DraftFieldName = (typeof draftFields)[number];
export type DraftIssueCode =
	| 'missing'
	| 'unrecognized'
	| 'low_confidence'
	| 'missing_confidence'
	| 'date_defaulted'
	| 'non_twd'
	| 'invalid'
	| 'unknown_member'
	| 'not_equal_split'
	| 'future_date';
const draftCodes: DraftIssueCode[] = [
	'missing',
	'unrecognized',
	'low_confidence',
	'missing_confidence',
	'date_defaulted',
	'non_twd',
	'invalid',
	'unknown_member',
	'not_equal_split',
	'future_date'
];
export interface DraftIssue {
	field: DraftFieldName;
	code: DraftIssueCode;
}
export type SemanticRequestV3 = { requestId: string; referenceDate?: string } & (
	| {
			action: 'analyze';
			text: string;
			history?: ClarificationTurn[];
			images?: never;
			drafts?: never;
	  }
	| { action: 'analyze'; text?: string; images: string[]; history?: never; drafts?: never }
	| {
			action: 'revise';
			text: string;
			history?: ClarificationTurn[];
			drafts: Draft[];
			images?: never;
	  }
	| { action: 'commit'; drafts: Draft[]; text?: never; history?: never; images?: never }
);
export interface IssueV3 {
	field: string;
	code: IssueCode | 'not_a_receipt' | 'too_many_drafts';
}
export type SemanticResponseV3 =
	| {
			status: 'created';
			requestId: string;
			expenses: ExpenseRow[];
			replayed: boolean;
			metadata: Metadata | null;
	  }
	| {
			status: 'drafts';
			requestId: string;
			drafts: Draft[];
			reason: 'multiple' | 'incomplete';
			metadata: Metadata;
	  }
	| {
			status: 'rejected';
			requestId: string;
			issues: IssueV3[];
			draftIssues?: { draftId: string; issues: DraftIssue[] }[];
	  }
	| Extract<SemanticResponse, { status: 'needs_input' }>;
export type StatusResponseV3 =
	| { status: 'completed'; requestId: string; expenses: ExpenseRow[]; replayed: true }
	| Extract<StatusResponse, { status: 'not_found' }>;
export type SemanticStreamEventV3 =
	| Exclude<SemanticStreamEvent, { type: 'result' }>
	| { type: 'result'; result: SemanticResponseV3 };
function listV3<T>(raw: unknown, maximum: number, parse: (raw: unknown) => T, minimum = 1): T[] {
	if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) {
		throw new Error('Invalid list');
	}
	return raw.map(parse);
}
function dateV3(raw: unknown): string {
	const value = string(raw);
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
		!Number.isFinite(parsed.getTime()) ||
		parsed.getUTCFullYear() < 100 ||
		parsed.toISOString().slice(0, 10) !== value
	) {
		throw new Error('Invalid date');
	}
	return value;
}
function textV3(raw: unknown, maximum: number): string {
	const value = boundedText(raw, maximum);
	if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
		throw new Error('Invalid Unicode');
	}
	return value;
}
function emailV3(raw: unknown): string {
	const value = textV3(raw, 320);
	if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
		throw new Error('Invalid email');
	}
	return value;
}
function currencyV3(raw: unknown): string {
	if (typeof raw !== 'string' || !/^[A-Z]{3}$/.test(raw)) {
		throw new Error('Invalid currency');
	}
	return raw;
}
function draftIssuesV3(raw: unknown): DraftIssue[] {
	if (!Array.isArray(raw)) {
		throw new Error('Invalid issues');
	}
	return raw.map((raw) => {
		const i = object(raw);
		exactKeys(i, ['field', 'code']);
		if (
			!draftFields.includes(i.field as DraftFieldName) ||
			!draftCodes.includes(i.code as DraftIssueCode)
		) {
			throw new Error('Invalid draft issue');
		}
		return { field: i.field as DraftFieldName, code: i.code as DraftIssueCode };
	});
}
export function parseDraftV3(raw: unknown): Draft {
	const r = object(raw);
	exactKeys(
		r,
		['draftId', ...draftFields, 'status', 'issues'],
		['mergedFrom', 'originalAmount', 'updated']
	);
	const result: Record<string, unknown> = { draftId: requestId(r.draftId) };
	if (Object.hasOwn(r, 'mergedFrom')) {
		result.mergedFrom = listV3(r.mergedFrom, MAX_DRAFTS, requestId);
	}
	for (const key of draftFields) {
		const f = object(r[key]);
		exactKeys(f, [
			'value',
			'state',
			'confidence',
			'source',
			...(key === 'date' ? ['defaulted'] : [])
		]);
		if (
			!['recognized', 'unrecognized', 'missing', 'explicit_null'].includes(
				f.state as string
			) ||
			!['image', 'text', 'default', 'user'].includes(f.source as string)
		) {
			throw new Error('Invalid field');
		}
		if (
			f.confidence !== null &&
			(typeof f.confidence !== 'number' ||
				!Number.isFinite(f.confidence) ||
				f.confidence < 0 ||
				f.confidence > 1)
		) {
			throw new Error('Invalid confidence');
		}
		if (f.state === 'explicit_null' && f.value !== null) {
			throw new Error('Invalid explicit null');
		}
		let value = f.value;
		if (value !== null) {
			if (key === 'amount') {
				value = integer(value, 1);
			} else if (key === 'date') {
				value = dateV3(value);
			} else if (key === 'currency') {
				value = currencyV3(value);
			} else if (key === 'payerEmail') {
				value = emailV3(value);
			} else if (key === 'splitMemberEmails') {
				value = listV3(value, Number.MAX_SAFE_INTEGER, emailV3, 0);
			} else if (key === 'scope') {
				if (value !== 'personal' && value !== 'household') {
					throw new Error('Invalid scope');
				}
			} else {
				value = textV3(value, key === 'note' ? 200 : 1024);
			}
		}
		const field: Record<string, unknown> = {
			value,
			state: f.state,
			confidence: f.confidence,
			source: f.source
		};
		if (key === 'date') {
			if (f.defaulted !== null && f.defaulted !== 'unreadable' && f.defaulted !== 'future') {
				throw new Error('Invalid default');
			}
			field.defaulted = f.defaulted;
		}
		result[key] = field;
	}
	if (Object.hasOwn(r, 'originalAmount')) {
		if (r.originalAmount === null) {
			result.originalAmount = null;
		} else {
			const o = object(r.originalAmount);
			exactKeys(o, ['text', 'currency']);
			result.originalAmount = { text: textV3(o.text, 200), currency: currencyV3(o.currency) };
		}
	}
	if (r.status !== 'complete' && r.status !== 'incomplete') {
		throw new Error('Invalid draft status');
	}
	result.status = r.status;
	result.issues = draftIssuesV3(r.issues);
	if (Object.hasOwn(r, 'updated')) {
		if (typeof r.updated !== 'boolean') {
			throw new Error('Invalid updated');
		}
		result.updated = r.updated;
	}
	return result as unknown as Draft;
}
export function parseRequestV3(raw: unknown): SemanticRequestV3 {
	const r = object(raw);
	const image = r.action === 'analyze' && Object.hasOwn(r, 'images');
	const required =
		r.action === 'commit'
			? ['drafts']
			: image
				? ['images']
				: r.action === 'revise'
					? ['text', 'drafts']
					: ['text'];
	if (!['analyze', 'revise', 'commit'].includes(r.action as string)) {
		throw new Error('Invalid action');
	}
	exactKeys(
		r,
		['requestId', 'action', ...required],
		['referenceDate', ...(image ? ['text'] : r.action === 'commit' ? [] : ['history'])]
	);
	const result: Record<string, unknown> = { requestId: requestId(r.requestId), action: r.action };
	if (Object.hasOwn(r, 'text')) {
		result.text =
			image && typeof r.text === 'string' && !r.text.trim() ? '' : textV3(r.text, 500);
	}
	if (Object.hasOwn(r, 'history')) {
		const history = parseRequest({
			requestId: result.requestId,
			text: 'history',
			history: r.history
		}).history;
		if (history) {
			result.history = history.map((turn) => ({
				question: textV3(turn.question, 300),
				answer: textV3(turn.answer, 500)
			}));
		}
	}
	if (Object.hasOwn(r, 'referenceDate')) {
		result.referenceDate = dateV3(r.referenceDate);
	}
	if (image) {
		result.images = listV3(r.images, MAX_IMAGES, (raw) => {
			const path = textV3(raw, MAX_IMAGE_PATH_LENGTH);
			if (path !== raw || path.includes('..')) {
				throw new Error('Invalid image path');
			}
			return path;
		});
	}
	if (Object.hasOwn(r, 'drafts')) {
		result.drafts = listV3(r.drafts, MAX_DRAFTS, parseDraftV3);
	}
	return result as SemanticRequestV3;
}
function metadataV3(raw: unknown): Metadata {
	const m = object(raw);
	exactKeys(m, ['model', 'promptVersion', 'inputTokens', 'outputTokens', 'elapsedMs']);
	string(m.model);
	string(m.promptVersion);
	integer(m.elapsedMs);
	for (const key of ['inputTokens', 'outputTokens']) {
		if (m[key] !== null) {
			integer(m[key]);
		}
	}
	return m as unknown as Metadata;
}
export function parseResponseV3(raw: unknown): SemanticResponseV3 {
	const r = object(raw);
	const id = requestId(r.requestId);
	if (r.status === 'needs_input') {
		return parseResponse(r) as Extract<SemanticResponse, { status: 'needs_input' }>;
	}
	if (r.status === 'created') {
		exactKeys(r, ['status', 'requestId', 'expenses', 'replayed', 'metadata']);
		if (typeof r.replayed !== 'boolean') {
			throw new Error('Invalid replay');
		}
		return {
			status: 'created',
			requestId: id,
			expenses: listV3(r.expenses, MAX_DRAFTS, parseExpenseRow),
			replayed: r.replayed,
			metadata: r.metadata === null ? null : metadataV3(r.metadata)
		};
	}
	if (r.status === 'drafts') {
		exactKeys(r, ['status', 'requestId', 'drafts', 'reason', 'metadata']);
		if (r.reason !== 'multiple' && r.reason !== 'incomplete') {
			throw new Error('Invalid reason');
		}
		return {
			status: 'drafts',
			requestId: id,
			drafts: listV3(r.drafts, MAX_DRAFTS, parseDraftV3),
			reason: r.reason,
			metadata: metadataV3(r.metadata)
		};
	}
	if (r.status !== 'rejected') {
		throw new Error('Invalid status');
	}
	exactKeys(r, ['status', 'requestId', 'issues'], ['draftIssues']);
	const issues = listV3(r.issues, Number.MAX_SAFE_INTEGER, (raw): IssueV3 => {
		const i = object(raw);
		exactKeys(i, ['field', 'code']);
		if (![...codes, 'not_a_receipt', 'too_many_drafts'].includes(i.code as string)) {
			throw new Error('Invalid issue');
		}
		return { field: string(i.field), code: i.code as IssueV3['code'] };
	});
	const result: Extract<SemanticResponseV3, { status: 'rejected' }> = {
		status: 'rejected',
		requestId: id,
		issues
	};
	if (Object.hasOwn(r, 'draftIssues')) {
		result.draftIssues = listV3(r.draftIssues, MAX_DRAFTS, (raw) => {
			const i = object(raw);
			exactKeys(i, ['draftId', 'issues']);
			const issues = draftIssuesV3(i.issues);
			if (!issues.length) {
				throw new Error('Empty issues');
			}
			return { draftId: requestId(i.draftId), issues };
		});
	}
	return result;
}
export function parseStatusResponseV3(raw: unknown): StatusResponseV3 {
	const r = object(raw);
	if (r.status === 'not_found') {
		return parseStatusResponse(r) as Extract<StatusResponse, { status: 'not_found' }>;
	}
	exactKeys(r, ['status', 'requestId', 'expenses', 'replayed']);
	if (r.status !== 'completed' || r.replayed !== true) {
		throw new Error('Invalid completed');
	}
	return {
		status: 'completed',
		requestId: requestId(r.requestId),
		expenses: listV3(r.expenses, MAX_DRAFTS, parseExpenseRow),
		replayed: true
	};
}
export function parseStreamEventV3(event: string, raw: unknown): SemanticStreamEventV3 {
	return event === 'result'
		? { type: 'result', result: parseResponseV3(raw) }
		: (parseStreamEvent(event, raw) as Exclude<SemanticStreamEvent, { type: 'result' }>);
}
// Use this at JSON boundaries when duplicate keys must be rejected before parsing objects.
export function loadJsonV3(text: string): unknown {
	const parsed: unknown = JSON.parse(text);
	const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
	let index = 0;
	function value(): void {
		const token = tokens[index++];
		if (token === '{') {
			const keys = new Set<string>();
			while (tokens[index] !== '}') {
				const key = JSON.parse(tokens[index++]);
				if (keys.has(key)) {
					throw new Error('Duplicate JSON key');
				}
				keys.add(key);
				index++;
				value();
				if (tokens[index] !== ',') {
					break;
				}
				index++;
			}
			index++;
		} else if (token === '[') {
			while (tokens[index] !== ']') {
				value();
				if (tokens[index] !== ',') {
					break;
				}
				index++;
			}
			index++;
		}
	}
	value();
	function finite(raw: unknown): void {
		if (typeof raw === 'number' && !Number.isFinite(raw)) {
			throw new Error('Invalid JSON number');
		}
		if (raw && typeof raw === 'object') {
			Object.values(raw).forEach(finite);
		}
	}
	finite(parsed);
	return object(parsed);
}
