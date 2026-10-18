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
