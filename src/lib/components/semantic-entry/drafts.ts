import type {
	Draft,
	ClientDraft,
	DraftIssue,
	DraftIssueCode,
	DraftFieldName
} from '@jopie/semantic-entry-contract';

export interface DraftItem {
	id: string;
	draft: Draft;
	hidden: boolean;
	groupId?: number;
	edited: boolean;
}
export interface DraftSession {
	items: DraftItem[];
	groupSummaries: Record<number, Draft>;
}
export interface DraftContext {
	today: string;
	categoryIds: Set<string>;
	allowedEmails: string[];
	currentUserEmail: string;
}
const requiredFields = [
	'note',
	'amount',
	'currency',
	'date',
	'categoryId',
	'scope',
	'payerEmail'
] as const;
const priority: DraftIssueCode[] = [
	'missing',
	'unrecognized',
	'invalid',
	'non_twd',
	'unknown_member',
	'not_equal_split',
	'future_date',
	'date_defaulted',
	'low_confidence',
	'missing_confidence'
];
export function draftIssues(draft: Draft, ctx: DraftContext): DraftIssue[] {
	const issues = new Map<DraftFieldName, DraftIssue>();
	function add(field: DraftFieldName, code: DraftIssueCode) {
		const previous = issues.get(field);
		if (!previous || priority.indexOf(code) < priority.indexOf(previous.code)) {
			issues.set(field, { field, code });
		}
	}
	for (const key of requiredFields) {
		const field = draft[key];
		if (field.value === null) {
			add(key, field.state === 'unrecognized' ? 'unrecognized' : 'missing');
		}
	}
	for (const key of [...requiredFields, 'splitMemberEmails'] as const) {
		const field = draft[key];
		if (field.source === 'image' && field.confidence === null) {
			add(key, 'missing_confidence');
		}
		if (field.confidence !== null && field.confidence < 0.7) {
			add(key, 'low_confidence');
		}
	}
	if (draft.note.value !== null && !draft.note.value.trim()) {
		add('note', 'invalid');
	}
	if (
		draft.amount.value !== null &&
		(!Number.isSafeInteger(draft.amount.value) ||
			draft.amount.value <= 0 ||
			draft.amount.value > 9999999999)
	) {
		add('amount', 'invalid');
	}
	if (draft.currency.value !== null && draft.currency.value !== 'TWD') {
		add('currency', 'non_twd');
	}
	if (draft.date.defaulted === 'unreadable' && draft.date.source !== 'user') {
		add('date', 'date_defaulted');
	}
	if (draft.date.value !== null) {
		const parsed = new Date(`${draft.date.value}T00:00:00Z`);
		if (
			!Number.isFinite(parsed.getTime()) ||
			parsed.toISOString().slice(0, 10) !== draft.date.value
		) {
			add('date', 'invalid');
		} else if (draft.date.value > ctx.today) {
			add('date', 'future_date');
		}
	}
	if (draft.categoryId.value !== null && !ctx.categoryIds.has(draft.categoryId.value)) {
		add('categoryId', 'invalid');
	}
	if (draft.scope.value === 'household') {
		const members = draft.splitMemberEmails.value ?? [];
		if (
			new Set(members).size < 2 ||
			members.some((email) => !ctx.allowedEmails.includes(email))
		) {
			add('splitMemberEmails', 'unknown_member');
		}
		if (
			draft.payerEmail.value !== null &&
			!ctx.allowedEmails.includes(draft.payerEmail.value)
		) {
			add('payerEmail', 'unknown_member');
		}
	} else if (
		draft.scope.value === 'personal' &&
		draft.payerEmail.value !== null &&
		draft.payerEmail.value !== ctx.currentUserEmail
	) {
		add('payerEmail', 'invalid');
	}
	return [...issues.values()];
}
export const isComplete = (draft: Draft) => draft.issues.length === 0;
export function fromServerDrafts(drafts: Draft[]): DraftSession {
	const items: DraftItem[] = drafts.map((draft) => ({
		id: draft.draftId,
		draft,
		hidden: false,
		edited: false
	}));
	const groups = new Map<string, DraftItem[]>();
	for (const item of items) {
		const values = [
			item.draft.note.value,
			item.draft.currency.value,
			item.draft.date.value,
			item.draft.scope.value,
			item.draft.payerEmail.value
		];
		if (values.some((value) => value === null)) {
			continue;
		}
		const key = JSON.stringify(values);
		const members = groups.get(key) ?? [];
		members.push(item);
		groups.set(key, members);
	}
	let groupId = 0;
	for (const members of groups.values()) {
		if (members.length >= 2) {
			groupId++;
			members.forEach((item) => {
				item.groupId = groupId;
			});
		}
	}
	return { items, groupSummaries: {} };
}
export function effectiveDrafts(session: DraftSession, ctx?: DraftContext): Draft[] {
	const visible = session.items.filter((item) => !item.hidden);
	const seen = new Set<number>();
	return visible.flatMap((item) => {
		const members =
			item.groupId === undefined
				? [item]
				: visible.filter((other) => other.groupId === item.groupId);
		if (item.groupId !== undefined) {
			if (seen.has(item.groupId)) {
				return [];
			}
			seen.add(item.groupId);
		}
		if (members.length === 1) {
			if (!item.edited || !ctx) {
				return [item.draft];
			}
			const issues = draftIssues(item.draft, ctx);
			return [{ ...item.draft, issues, status: issues.length ? 'incomplete' : 'complete' }];
		}
		if (item.groupId !== undefined && session.groupSummaries[item.groupId]) {
			const summary = {
				...session.groupSummaries[item.groupId],
				draftId: members[0].id,
				mergedFrom: members.map((member) => member.id)
			};
			if (ctx) {
				summary.issues = draftIssues(summary, ctx);
				summary.status = summary.issues.length ? 'incomplete' : 'complete';
			}
			return [summary];
		}
		const amount = members.some((member) => member.draft.amount.value === null)
			? null
			: members.reduce((sum, member) => sum + member.draft.amount.value!, 0);
		const draft: Draft = {
			...item.draft,
			mergedFrom: members.map((member) => member.id),
			amount: {
				value: amount,
				state: amount === null ? 'missing' : 'recognized',
				confidence: null,
				source: 'user'
			}
		};
		// Without external context, preserve server checks for fields the merge did not change.
		draft.issues = ctx
			? draftIssues(draft, ctx)
			: [
					...draft.issues.filter((issue) => issue.field !== 'amount'),
					...(amount === null
						? [{ field: 'amount', code: 'missing' } as const]
						: !Number.isSafeInteger(amount) || amount <= 0 || amount > 9999999999
							? [{ field: 'amount', code: 'invalid' } as const]
							: [])
				];
		draft.status = isComplete(draft) ? 'complete' : 'incomplete';
		return [draft];
	});
}
export function toClientDraft(draft: Draft): ClientDraft {
	const result = { ...draft } as Partial<Draft>;
	delete result.status;
	delete result.issues;
	delete result.updated;
	return result as ClientDraft;
}
const labels: Record<DraftFieldName, string> = {
	note: '內容',
	amount: '金額',
	currency: '幣別',
	date: '日期',
	categoryId: '分類',
	scope: '範圍',
	payerEmail: '付款人',
	splitMemberEmails: '分攤成員'
};
export function issueText(issue: DraftIssue): string {
	const label = labels[issue.field];
	switch (issue.code) {
		case 'missing':
			return issue.field === 'categoryId' ? '分類未選' : `${label}未填`;
		case 'unrecognized':
			return `${label}無法辨識`;
		case 'low_confidence':
		case 'missing_confidence':
			return `${label}需確認`;
		case 'date_defaulted':
			return '日期無法辨識';
		case 'non_twd':
			return '需換算成 TWD';
		case 'invalid':
			return issue.field === 'categoryId' ? '分類已不存在，請重新選擇' : `${label}無效`;
		case 'unknown_member':
			return `${label}不在成員名單`;
		case 'not_equal_split':
			return '只支援平分';
		case 'future_date':
			return '日期不能晚於今天';
	}
}
export const formatAmount = (amount: number) => amount.toLocaleString('en-US');
export function draftAmount(draft: Draft): string {
	if (draft.amount.value === null) {
		return '—';
	}
	if (draft.currency.value === 'TWD') {
		return `NT$ ${formatAmount(draft.amount.value)}`;
	}
	return draft.originalAmount?.text ?? `${draft.currency.value ?? '—'} ${draft.amount.value}`;
}
export function draftSummary(drafts: Draft[]): string {
	const incomplete = drafts.flatMap((draft, index) => (isComplete(draft) ? [] : [index + 1]));
	return incomplete.length
		? `第 ${incomplete.join('、')} 筆需要補齊。`
		: `${drafts.length} 筆都完整，合計 NT$ ${formatAmount(drafts.reduce((sum, draft) => sum + (draft.amount.value ?? 0), 0))}。`;
}
