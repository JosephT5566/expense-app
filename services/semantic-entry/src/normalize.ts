import {
	exactKeys,
	object,
	type Issue,
	type ModelExtraction,
	type SemanticContext,
	type ValidationResult
} from '@jopie/semantic-entry-contract';
import { taiwanDayBoundsISO } from '../../../src/lib/utils/dates';
export function parseExtraction(raw: unknown): ModelExtraction {
	const r = object(raw);
	exactKeys(r, [
		'note',
		'amount',
		'currency',
		'date',
		'payerId',
		'scope',
		'hasSharedIntent',
		'splitMemberIds',
		'categoryId',
		'unsupportedReason'
	]);
	for (const key of ['note', 'currency', 'payerId', 'categoryId', 'unsupportedReason']) {
		if (r[key] !== null && typeof r[key] !== 'string') {
			throw new Error('Invalid extraction');
		}
	}
	if (r.amount !== null && typeof r.amount !== 'number') {
		throw new Error('Invalid amount');
	}
	if (r.scope !== null && r.scope !== 'personal' && r.scope !== 'household') {
		throw new Error('Invalid scope');
	}
	if (
		typeof r.hasSharedIntent !== 'boolean' ||
		(r.splitMemberIds !== null &&
			(!Array.isArray(r.splitMemberIds) ||
				r.splitMemberIds.some((id) => typeof id !== 'string')))
	) {
		throw new Error('Invalid split');
	}
	const date = object(r.date);
	exactKeys(date, ['kind', 'value']);
	if (
		!['today', 'yesterday', 'day_before_yesterday', 'absolute', 'missing'].includes(
			String(date.kind)
		) ||
		(date.value !== null && typeof date.value !== 'string')
	) {
		throw new Error('Invalid date');
	}
	if (date.kind !== 'absolute' && date.value !== null) {
		throw new Error('Invalid relative date');
	}
	return r as unknown as ModelExtraction;
}
function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	const date = new Date(`${value}T00:00:00Z`);
	return (
		Number.isFinite(date.getTime()) &&
		date.toISOString().slice(0, 10) === value &&
		Number(value.slice(0, 4)) >= 100
	);
}
export function normalizeExtraction(raw: unknown, ctx: SemanticContext): ValidationResult {
	let r: ModelExtraction;
	try {
		r = parseExtraction(raw);
	} catch {
		return { status: 'rejected', issues: [{ field: 'extraction', code: 'invalid' }] };
	}
	const issues: Issue[] = [];
	const issue = (field: string, code: Issue['code']) => {
		issues.push({ field, code });
	};
	if (!r.note?.trim()) {
		issue('note', 'missing');
	}
	if (r.amount === null) {
		issue('amount', 'missing');
	} else if (!Number.isSafeInteger(r.amount) || r.amount <= 0) {
		issue('amount', 'invalid');
	}
	if (r.currency !== null && r.currency !== 'TWD') {
		issue('currency', 'unsupported');
	}
	if (r.unsupportedReason !== null) {
		issue('intent', 'unsupported');
	}
	const member = (id: string) => {
		const found = ctx.members.filter((m) => m.id === id);
		if (found.length !== 1) {
			issue('members', found.length ? 'ambiguous_member' : 'unknown_member');
			return undefined;
		}
		if (ctx.members.filter((m) => m.email === found[0].email).length !== 1) {
			issue('members', 'ambiguous_member');
			return undefined;
		}
		return found[0];
	};
	const caller = ctx.members.filter((m) => m.email === ctx.currentUserEmail);
	if (caller.length !== 1) {
		issue('members', 'configuration');
	}
	const payer = r.payerId === null ? caller[0] : member(r.payerId);
	const scope = r.scope ?? (r.hasSharedIntent ? 'household' : 'personal');
	const shares: Record<string, number> = {};
	if (scope === 'personal') {
		if (payer?.email !== ctx.currentUserEmail) {
			issue('payerId', 'unsupported');
		}
		if (r.hasSharedIntent || r.splitMemberIds !== null) {
			issue('splitMemberIds', 'unsupported');
		}
		shares[ctx.currentUserEmail] = r.amount ?? 0;
	} else {
		const ids = r.splitMemberIds;
		if (!ids || ids.length < 2) {
			issue('splitMemberIds', 'ambiguous_member');
		} else if (new Set(ids).size !== ids.length) {
			issue('splitMemberIds', 'invalid');
		} else {
			const members = ids
				.map(member)
				.filter((m) => m !== undefined)
				.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
			if (
				members.length === ids.length &&
				r.amount !== null &&
				Number.isSafeInteger(r.amount) &&
				r.amount > 0
			) {
				const each = Math.floor(r.amount / members.length);
				for (const [index, m] of members.entries()) {
					shares[m.email] = each + (index === 0 ? r.amount % members.length : 0);
				}
			}
		}
	}
	const categoryId = r.categoryId ?? ctx.otherCategoryId;
	if (!ctx.categories.some((c) => c.id === categoryId)) {
		issue('categoryId', r.categoryId === null ? 'configuration' : 'invalid');
	}
	let date = ctx.today;
	if (!validDate(ctx.today)) {
		issue('date', 'configuration');
	} else if (r.date.kind === 'absolute') {
		if (!r.date.value || !validDate(r.date.value) || r.date.value > ctx.today) {
			issue('date', 'invalid');
		} else {
			date = r.date.value;
		}
	} else {
		const offset =
			r.date.kind === 'yesterday' ? 1 : r.date.kind === 'day_before_yesterday' ? 2 : 0;
		date = new Date(Date.parse(`${ctx.today}T00:00:00Z`) - offset * 86400000)
			.toISOString()
			.slice(0, 10);
	}
	if (issues.length || !payer || r.amount === null || !r.note) {
		return { status: 'rejected', issues };
	}
	return {
		status: 'valid',
		expense: {
			note: r.note.trim(),
			amount: r.amount,
			currency: 'TWD',
			ts: taiwanDayBoundsISO(date).from,
			payer_email: payer.email,
			scope,
			shares_json: shares,
			category_id: categoryId,
			is_settled: scope === 'personal'
		}
	};
}
