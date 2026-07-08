import { supabase } from '$lib/supabase/supabaseClient';
import type {
	Currency,
	ExpenseScope,
	PageResult,
	ScheduledExpenseRecurrence,
	ScheduledExpenseRow,
	ScheduledExpenseStatus,
	ShareEntry
} from '$lib/types/expense';
import { user as currentUser } from '$lib/stores/session.store';
import { upsertExpense } from '$lib/data/expenses.fetcher';
import { get } from 'svelte/store';

const TABLE = 'scheduled_expenses';
const DEFAULT_TIMEZONE = 'Asia/Taipei';
const TAIWAN_OFFSET_HOURS = 8;

export interface ScheduledExpenseQuery {
	status?: ScheduledExpenseStatus | 'all';
	kind?: ScheduledExpenseRow['kind'] | 'all';
	from?: string;
	to?: string;
	limit?: number;
}

export interface UpsertScheduledExpenseInput {
	id?: string;
	owner_email: string;
	payer_email: string;
	note: string;
	amount: number;
	currency: Currency;
	scheduled_for: string;
	timezone?: string;
	scope: ExpenseScope;
	shares_json: ShareEntry;
	category_id?: string | null;
	kind: ScheduledExpenseRow['kind'];
	recurrence_rule?: ScheduledExpenseRecurrence | null;
	recurrence_weekday?: number | null;
	recurrence_month_day?: number | null;
}

export async function listScheduledExpenses(
	params: ScheduledExpenseQuery = {}
): Promise<PageResult<ScheduledExpenseRow>> {
	const currentUserEmail = get(currentUser)?.email ?? '';
	const limit = params.limit ?? 100;

	let query = supabase
		.from(TABLE)
		.select('*')
		.eq('owner_email', currentUserEmail)
		.order('scheduled_for', { ascending: true })
		.order('created_at', { ascending: false })
		.limit(limit);

	if (params.status && params.status !== 'all') {
		query = query.eq('status', params.status);
	}

	if (params.kind && params.kind !== 'all') {
		query = query.eq('kind', params.kind);
	}

	if (params.from) {
		query = query.gte('scheduled_for', params.from);
	}

	if (params.to) {
		query = query.lte('scheduled_for', params.to);
	}

	const { data, error } = await query;
	if (error) {
		throw error;
	}

	return { items: (data ?? []) as ScheduledExpenseRow[], nextCursor: null };
}

export async function listDueScheduledExpenses(params: { limit?: number } = {}) {
	return listScheduledExpenses({
		status: 'pending',
		to: new Date().toISOString(),
		limit: params.limit ?? 100
	});
}

export async function getScheduledExpenseById(id: string): Promise<ScheduledExpenseRow | null> {
	const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();

	if (error) {
		throw error;
	}

	return (data as ScheduledExpenseRow) ?? null;
}

export async function upsertScheduledExpense(
	input: UpsertScheduledExpenseInput
): Promise<ScheduledExpenseRow> {
	const payload = normalizeScheduledExpenseInput(input);
	const { data, error } = await supabase.from(TABLE).upsert(payload).select().single();

	if (error) {
		throw error;
	}

	return data as ScheduledExpenseRow;
}

export async function cancelScheduledExpense(id: string): Promise<ScheduledExpenseRow> {
	const { data, error } = await supabase
		.from(TABLE)
		.update({ status: 'cancelled', updated_at: new Date().toISOString() })
		.eq('id', id)
		.select()
		.single();

	if (error) {
		throw error;
	}

	return data as ScheduledExpenseRow;
}

export async function deleteScheduledExpense(id: string): Promise<{ status: number }> {
	const { error, status } = await supabase.from(TABLE).delete().eq('id', id);

	if (error) {
		throw error;
	}

	return { status };
}

export async function confirmScheduledExpense(id: string): Promise<{
	expense: Awaited<ReturnType<typeof upsertExpense>>;
	scheduledExpense: ScheduledExpenseRow;
}> {
	const scheduledExpense = await getScheduledExpenseById(id);

	if (!scheduledExpense) {
		throw new Error('Scheduled expense not found');
	}

	if (scheduledExpense.status !== 'pending') {
		throw new Error('Only pending scheduled expenses can be confirmed');
	}

	if (scheduledExpense.scheduled_for > new Date().toISOString()) {
		throw new Error('Scheduled expense is not due yet');
	}

	const expense = await upsertExpense({
		note: scheduledExpense.note,
		amount: Number(scheduledExpense.amount),
		currency: scheduledExpense.currency,
		ts: scheduledExpense.scheduled_for,
		payer_email: scheduledExpense.payer_email,
		scope: scheduledExpense.scope,
		shares_json: scheduledExpense.shares_json,
		category_id: scheduledExpense.category_id ?? null,
		is_settled: scheduledExpense.scope === 'personal'
	});

	const updatePayload =
		scheduledExpense.kind === 'recurring'
			? {
					status: 'pending' satisfies ScheduledExpenseStatus,
					scheduled_for: getNextScheduledOccurrence(scheduledExpense),
					created_expense_id: expense.id,
					updated_at: new Date().toISOString()
				}
			: {
					status: 'confirmed' satisfies ScheduledExpenseStatus,
					created_expense_id: expense.id,
					updated_at: new Date().toISOString()
				};

	const { data, error } = await supabase
		.from(TABLE)
		.update(updatePayload)
		.eq('id', scheduledExpense.id)
		.select()
		.single();

	if (error) {
		throw error;
	}

	return { expense, scheduledExpense: data as ScheduledExpenseRow };
}

export function getNextScheduledOccurrence(
	row: Pick<
		ScheduledExpenseRow,
		| 'scheduled_for'
		| 'timezone'
		| 'recurrence_rule'
		| 'recurrence_weekday'
		| 'recurrence_month_day'
	>
): string {
	const timezone = row.timezone || DEFAULT_TIMEZONE;
	if (timezone !== DEFAULT_TIMEZONE) {
		throw new Error(`Unsupported scheduled expense timezone: ${timezone}`);
	}

	if (row.recurrence_rule === 'daily') {
		return addTaiwanCalendarDays(row.scheduled_for, 1);
	}

	if (row.recurrence_rule === 'weekly') {
		validateWeekday(row.recurrence_weekday);
		return nextTaiwanWeekday(row.scheduled_for, row.recurrence_weekday);
	}

	if (row.recurrence_rule === 'monthly') {
		validateMonthDay(row.recurrence_month_day);
		return nextTaiwanMonthDay(row.scheduled_for, row.recurrence_month_day);
	}

	throw new Error('Recurring scheduled expense requires a recurrence rule');
}

function normalizeScheduledExpenseInput(input: UpsertScheduledExpenseInput) {
	if (input.kind === 'recurring') {
		if (!input.recurrence_rule) {
			throw new Error('Recurring scheduled expense requires a recurrence rule');
		}

		if (input.recurrence_rule === 'weekly') {
			validateWeekday(input.recurrence_weekday);
		}

		if (input.recurrence_rule === 'monthly') {
			validateMonthDay(input.recurrence_month_day);
		}
	}

	return {
		...input,
		timezone: input.timezone ?? DEFAULT_TIMEZONE,
		category_id: input.category_id || null,
		recurrence_rule: input.kind === 'recurring' ? input.recurrence_rule : null,
		recurrence_weekday:
			input.kind === 'recurring' && input.recurrence_rule === 'weekly'
				? input.recurrence_weekday
				: null,
		recurrence_month_day:
			input.kind === 'recurring' && input.recurrence_rule === 'monthly'
				? input.recurrence_month_day
				: null,
		updated_at: new Date().toISOString()
	};
}

function validateWeekday(value: number | null | undefined): asserts value is number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) {
		throw new Error('Weekly scheduled expense requires recurrence_weekday between 0 and 6');
	}
}

function validateMonthDay(value: number | null | undefined): asserts value is number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
		throw new Error('Monthly scheduled expense requires recurrence_month_day between 1 and 31');
	}
}

function addTaiwanCalendarDays(iso: string, days: number) {
	const parts = getTaiwanParts(iso);
	return taiwanPartsToISO({
		...parts,
		day: parts.day + days
	});
}

function nextTaiwanWeekday(iso: string, weekday: number) {
	const parts = getTaiwanParts(iso);
	const current = taiwanDateToUtcDate(parts.year, parts.month, parts.day);
	const currentWeekday = current.getUTCDay();
	const diff = (weekday - currentWeekday + 7) % 7 || 7;

	return taiwanPartsToISO({
		...parts,
		day: parts.day + diff
	});
}

function nextTaiwanMonthDay(iso: string, monthDay: number) {
	const parts = getTaiwanParts(iso);
	const nextMonth = parts.month + 1;
	const lastDay = getLastTaiwanMonthDay(parts.year, nextMonth);

	return taiwanPartsToISO({
		...parts,
		month: nextMonth,
		day: Math.min(monthDay, lastDay)
	});
}

function getTaiwanParts(iso: string) {
	const date = new Date(iso);
	const taiwanTime = new Date(date.getTime() + TAIWAN_OFFSET_HOURS * 60 * 60 * 1000);

	return {
		year: taiwanTime.getUTCFullYear(),
		month: taiwanTime.getUTCMonth() + 1,
		day: taiwanTime.getUTCDate(),
		hour: taiwanTime.getUTCHours(),
		minute: taiwanTime.getUTCMinutes(),
		second: taiwanTime.getUTCSeconds(),
		millisecond: taiwanTime.getUTCMilliseconds()
	};
}

function taiwanPartsToISO(parts: ReturnType<typeof getTaiwanParts>) {
	return new Date(
		Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour - TAIWAN_OFFSET_HOURS,
			parts.minute,
			parts.second,
			parts.millisecond
		)
	).toISOString();
}

function taiwanDateToUtcDate(year: number, month: number, day: number) {
	return new Date(Date.UTC(year, month - 1, day));
}

function getLastTaiwanMonthDay(year: number, month: number) {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
