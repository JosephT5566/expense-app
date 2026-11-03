import type { CategoryRow } from '$lib/types/category';

// Custom categorical palette with varied lightness, not a standard named palette.
// Every active/reserved pair differs by >=20° hue or >=12 HSL lightness points.
// At most 3 colors may lie in 70–190°; those pairs need >=40° hue or >=12 lightness.
// All active/reserved colors contrast >=3:1 on white and both Moss Night backgrounds.
// Numerical/CVD simulation checks do not guarantee recognition of a 4px dot.
export const CATEGORY_COLORS: readonly string[] = [
	'#2486db',
	'#d36f22',
	'#289f50',
	'#d043ad',
	'#a55012',
	'#6242ff',
	'#ee6363',
	'#226d87',
	'#4291ff',
	'#c70074',
	'#e252ff',
	'#8a43d0'
];
export const INACTIVE_CATEGORY_COLOR = '#9ca3af';
export const UNCATEGORIZED_COLOR = '#d9688e';
export const EMPTY_CATEGORY_COLOR = '#b314b3';

/** Assign the full category registry, never the current month's active groups.
 * Missing sort_order is 0, matching the database default; ties use UTF-16 id order.
 * Reserved ids consume no index. Overflow cycles index % N. Inserting/removing or
 * reordering categories can shift following colors; changing amounts cannot.
 */
export function createCategoryColorMap(
	categories: readonly Pick<CategoryRow, 'id' | 'sort_order'>[]
): ReadonlyMap<string, string> {
	const ordered = categories
		.filter(({ id }) => id !== '' && id !== 'uncategorized')
		.sort(
			(a, b) =>
				(a.sort_order ?? 0) - (b.sort_order ?? 0) ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
		);
	return new Map(
		ordered.map(({ id }, index) => [id, CATEGORY_COLORS[index % CATEGORY_COLORS.length]])
	);
}

/** Unknown ids (also before categories load) use unsigned base-31 UTF-16 hash % N.
 * Hash collisions are allowed. When the registry arrives, known ids switch to its
 * ordered colors. Reserved ids stay fixed; non-positive totals always take gray.
 */
export function getCategoryColor(
	id: string,
	amount: number,
	colors: ReadonlyMap<string, string>
): string {
	if (amount <= 0) {
		return INACTIVE_CATEGORY_COLOR;
	}
	if (id === 'uncategorized') {
		return UNCATEGORIZED_COLOR;
	}
	if (id === '') {
		return EMPTY_CATEGORY_COLOR;
	}
	const known = colors.get(id);
	if (known !== undefined) {
		return known;
	}
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
	}
	return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}
