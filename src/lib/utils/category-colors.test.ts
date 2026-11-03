import { describe, expect, it } from 'vitest';
import { getCategoryColor, INACTIVE_CATEGORY_COLOR } from './category-colors';

describe('getCategoryColor', () => {
	it('keeps the same id color across amounts and ordering', () => {
		const ids = ['a', 'b', '00000000-0000-4000-8000-000000000002'];
		const colors = Object.fromEntries(ids.map((id) => [id, getCategoryColor(id, 1)]));
		for (const id of [...ids].reverse()) {
			expect(getCategoryColor(id, 999)).toBe(colors[id]);
		}
	});
	it('maps different ids to fixed palette entries', () => {
		expect(getCategoryColor('a', 100)).toBe('hsl(47, 70%, 55%)');
		expect(getCategoryColor('b', 100)).toBe('hsl(94, 70%, 55%)');
		expect(getCategoryColor('uncategorized', 100)).toBe('hsl(0, 70%, 55%)');
	});
	it('uses gray for zero and negative amounts without changing other colors', () => {
		expect(getCategoryColor('a', 0)).toBe(INACTIVE_CATEGORY_COLOR);
		expect(getCategoryColor('unknown', -1)).toBe('#9ca3af');
		expect(getCategoryColor('uncategorized', 0)).toBe('#9ca3af');
		expect(getCategoryColor('b', 1)).toBe('hsl(94, 70%, 55%)');
	});
	it('hashes unknown ids deterministically, including empty and non-ASCII ids', () => {
		expect(getCategoryColor('new-category', 1)).toBe('hsl(157, 70%, 55%)');
		expect(getCategoryColor('', 1)).toBe('hsl(0, 70%, 55%)');
		expect(getCategoryColor('新', 1)).toBe('hsl(0, 70%, 55%)');
	});
});
