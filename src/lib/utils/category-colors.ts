// Preserve the chart's original hue sequence, saturation, and lightness.
const CATEGORY_COLORS = Array.from({ length: 16 }, (_, i) => `hsl(${(i * 47) % 360}, 70%, 55%)`);
export const INACTIVE_CATEGORY_COLOR = '#9ca3af';

/** Stable across category loading, names, ordering, months, and scopes.
 * There is no checked-in category UUID registry. Every other id, including new/unknown
 * ids, uses a base-31 unsigned UTF-16 hash into the same fixed palette. Collisions are allowed.
 */
export function getCategoryColor(id: string, amount: number): string {
	if (amount <= 0) {
		return INACTIVE_CATEGORY_COLOR;
	}
	if (id === 'uncategorized') {
		return CATEGORY_COLORS[0];
	}
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
	}
	return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}
