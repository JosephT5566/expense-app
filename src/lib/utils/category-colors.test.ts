import { describe, expect, it } from 'vitest';
import {
	CATEGORY_COLORS,
	createCategoryColorMap,
	EMPTY_CATEGORY_COLOR,
	getCategoryColor,
	INACTIVE_CATEGORY_COLOR,
	UNCATEGORIZED_COLOR
} from './category-colors';

const categories = [
	{ id: 'b', sort_order: 2 },
	{ id: 'a', sort_order: 1 },
	{ id: '新類別🍵', sort_order: 3 }
];

describe('category colors', () => {
	it('assigns by sort_order and id, independent of response order, month, amount or scope', () => {
		const map = createCategoryColorMap(categories);
		expect(createCategoryColorMap([...categories].reverse())).toEqual(map);
		expect(map.get('a')).toBe(CATEGORY_COLORS[0]);
		expect(map.get('b')).toBe(CATEGORY_COLORS[1]);
		expect(map.get('新類別🍵')).toBe(CATEGORY_COLORS[2]);
		for (const { id } of categories) {
			expect(getCategoryColor(id, 1, map)).toBe(getCategoryColor(id, 999, map));
		}
	});

	it('defaults missing sort_order to zero and breaks ties by UTF-16 id order', () => {
		const map = createCategoryColorMap([
			{ id: 'z', sort_order: 1 },
			{ id: 'b' },
			{ id: 'a', sort_order: 0 }
		]);
		expect([...map.keys()]).toEqual(['a', 'b', 'z']);
	});

	it('gives every listed category a unique color up to palette capacity, then cycles', () => {
		const rows = Array.from({ length: CATEGORY_COLORS.length + 2 }, (_, sort_order) => ({
			id: `category-${sort_order}`,
			sort_order
		}));
		const map = createCategoryColorMap(rows);
		expect(
			new Set(rows.slice(0, CATEGORY_COLORS.length).map(({ id }) => map.get(id))).size
		).toBe(CATEGORY_COLORS.length);
		expect(map.get(`category-${CATEGORY_COLORS.length}`)).toBe(CATEGORY_COLORS[0]);
		expect(map.get(`category-${CATEGORY_COLORS.length + 1}`)).toBe(CATEGORY_COLORS[1]);
	});

	it('uses gray for zero/negative amounts without reallocating other categories', () => {
		const map = createCategoryColorMap(categories);
		for (const id of ['a', 'b', 'uncategorized', '', 'unknown']) {
			expect(getCategoryColor(id, 0, map)).toBe('#9ca3af');
			expect(getCategoryColor(id, -10, map)).toBe(INACTIVE_CATEGORY_COLOR);
		}
		expect(getCategoryColor('b', 100, map)).toBe(CATEGORY_COLORS[1]);
		expect(map).toEqual(createCategoryColorMap(categories));
	});

	it('reserves separate colors for uncategorized and empty ids, outside the palette', () => {
		const map = createCategoryColorMap([{ id: '' }, { id: 'uncategorized' }, ...categories]);
		expect(getCategoryColor('uncategorized', 1, map)).toBe(UNCATEGORIZED_COLOR);
		expect(getCategoryColor('', 1, map)).toBe(EMPTY_CATEGORY_COLOR);
		expect(
			new Set([UNCATEGORIZED_COLOR, EMPTY_CATEGORY_COLOR, INACTIVE_CATEGORY_COLOR]).size
		).toBe(3);
		for (const color of [UNCATEGORIZED_COLOR, EMPTY_CATEGORY_COLOR, INACTIVE_CATEGORY_COLOR]) {
			expect(CATEGORY_COLORS).not.toContain(color);
		}
		expect(map.get('a')).toBe(CATEGORY_COLORS[0]);
	});

	it('uses the unsigned base-31 UTF-16 hash for unknown ids, including before loading', () => {
		const map = createCategoryColorMap(categories);
		// 'ab': 97 * 31 + 98 = 3105; '新': UTF-16 code unit 26032.
		expect(getCategoryColor('ab', 1, map)).toBe(CATEGORY_COLORS[3105 % CATEGORY_COLORS.length]);
		expect(getCategoryColor('新', 1, map)).toBe(
			CATEGORY_COLORS[26032 % CATEGORY_COLORS.length]
		);
		expect(getCategoryColor('ab', 999, createCategoryColorMap([]))).toBe(
			getCategoryColor('ab', 1, map)
		);
	});

	it('updates following indices on insertion/removal/reordering and when categories arrive', () => {
		const before = createCategoryColorMap(categories);
		const inserted = createCategoryColorMap([...categories, { id: 'aa', sort_order: 1 }]);
		expect(inserted.get('a')).toBe(before.get('a'));
		expect(inserted.get('b')).toBe(CATEGORY_COLORS[2]);
		expect(createCategoryColorMap(categories.filter(({ id }) => id !== 'a')).get('b')).toBe(
			CATEGORY_COLORS[0]
		);
		expect(createCategoryColorMap([{ id: 'b', sort_order: -1 }, { id: 'a' }]).get('b')).toBe(
			CATEGORY_COLORS[0]
		);
		expect(getCategoryColor('a', 1, createCategoryColorMap([]))).not.toBe(before.get('a'));
	});

	it('keeps 12 unique palette colors and two distinct reserved colors', () => {
		expect(CATEGORY_COLORS).toHaveLength(12);
		expect(new Set(CATEGORY_COLORS).size).toBe(12);
		expect(new Set([...CATEGORY_COLORS, UNCATEGORIZED_COLOR, EMPTY_CATEGORY_COLOR]).size).toBe(
			14
		);
	});

	it('limits yellow-green through cyan crowding and separates every active pair', () => {
		const colors = [...CATEGORY_COLORS, UNCATEGORIZED_COLOR, EMPTY_CATEGORY_COLOR].map(
			colorMetrics
		);
		const greenCyan = colors.filter(({ h }) => h >= 70 && h <= 190);
		expect(greenCyan.length).toBeLessThanOrEqual(3);
		for (const a of greenCyan) {
			for (const b of greenCyan) {
				if (a === b) {
					continue;
				}
				expect(hueGap(a.h, b.h) >= 40 || Math.abs(a.l - b.l) >= 12).toBe(true);
			}
		}
		const uncategorizedHue = colorMetrics(UNCATEGORIZED_COLOR).h;
		expect(uncategorizedHue < 70 || uncategorizedHue > 190).toBe(true);
		for (let i = 0; i < colors.length; i++) {
			// Gray has only 10.6% HSL saturation; keep active/reserved colors chromatic.
			expect(colors[i].s - colorMetrics(INACTIVE_CATEGORY_COLOR).s).toBeGreaterThanOrEqual(
				0.25
			);
			for (let j = i + 1; j < colors.length; j++) {
				expect(
					hueGap(colors[i].h, colors[j].h) >= 20 ||
						Math.abs(colors[i].l - colors[j].l) >= 12
				).toBe(true);
			}
		}
	});

	it('contrasts every active color at least 3:1 on white and both Moss Night backgrounds', () => {
		// src/lib/theme.css: moss --c-card and --c-bg. Inactive gray is excluded.
		const backgrounds = ['#ffffff', '#101b20', '#0b1215'].map(colorMetrics);
		for (const hex of [...CATEGORY_COLORS, UNCATEGORIZED_COLOR, EMPTY_CATEGORY_COLOR]) {
			expect(hex).toMatch(/^#[0-9a-f]{6}$/);
			const { luminance } = colorMetrics(hex);
			for (const background of backgrounds) {
				const ratio =
					(Math.max(luminance, background.luminance) + 0.05) /
					(Math.min(luminance, background.luminance) + 0.05);
				expect(ratio, hex).toBeGreaterThanOrEqual(3);
			}
		}
	});
});

function hueGap(a: number, b: number) {
	const gap = Math.abs(a - b);
	return Math.min(gap, 360 - gap);
}

function colorMetrics(hex: string) {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const linear = [r, g, b].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	const max = Math.max(r, g, b),
		min = Math.min(r, g, b),
		delta = max - min;
	const hue =
		delta === 0
			? 0
			: max === r
				? ((g - b) / delta) % 6
				: max === g
					? (b - r) / delta + 2
					: (r - g) / delta + 4;
	return {
		h: (hue * 60 + 360) % 360,
		l: (max + min) * 50,
		s: delta === 0 ? 0 : delta / (1 - Math.abs(max + min - 1)),
		luminance: linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
	};
}
