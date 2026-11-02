import { describe, expect, it } from 'vitest';
import { isWithinRange, taiwanMonthBoundsISO } from '$lib/utils/dates';

// 2026-10 in Taiwan: from 2026-09-30T16:00:00.000Z, to 2026-10-31T15:59:59.999Z.
const { from, to } = taiwanMonthBoundsISO(2026, 10);

describe('isWithinRange', () => {
	it('keeps the month bounds format unchanged', () => {
		expect(from).toBe('2026-09-30T16:00:00.000Z');
		expect(to).toBe('2026-10-31T15:59:59.999Z');
	});

	it('includes a Supabase-formatted ts exactly at the Taiwan month start', () => {
		expect(isWithinRange('2026-09-30T16:00:00+00:00', from, to)).toBe(true);
	});

	it('includes the last millisecond of the month', () => {
		expect(isWithinRange('2026-10-31T15:59:59.999+00:00', from, to)).toBe(true);
	});

	it('excludes one millisecond before the month start', () => {
		expect(isWithinRange('2026-09-30T15:59:59.999+00:00', from, to)).toBe(false);
	});

	it('excludes the next month start', () => {
		expect(isWithinRange('2026-10-31T16:00:00+00:00', from, to)).toBe(false);
	});

	it('treats Z and +00:00 as the same instant', () => {
		expect(isWithinRange('2026-09-30T16:00:00Z', from, to)).toBe(true);
		expect(isWithinRange('2026-09-30T16:00:00.000Z', from, to)).toBe(true);
		expect(isWithinRange('2026-10-01T00:00:00+08:00', from, to)).toBe(true);
	});

	it('returns false for an invalid ts', () => {
		expect(isWithinRange('not-a-date', from, to)).toBe(false);
		expect(isWithinRange('', from, to)).toBe(false);
	});

	it('leaves an omitted bound unrestricted', () => {
		expect(isWithinRange('2000-01-01T00:00:00+00:00', undefined, to)).toBe(true);
		expect(isWithinRange('2099-01-01T00:00:00+00:00', from, undefined)).toBe(true);
		expect(isWithinRange('2099-01-01T00:00:00+00:00', from, to)).toBe(false);
		expect(isWithinRange('2026-10-05T00:00:00+00:00', '', '')).toBe(true);
	});
});
