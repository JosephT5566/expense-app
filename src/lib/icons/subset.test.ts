import { expect, it } from 'vitest';
import collections from './iconify-subset.json';
import {
	assertSubsetCoverage,
	checkSourceIcons,
	generateSubset,
	sourceIconNames
} from '../../../scripts/generate-icon-subset.mjs';

it('commits exactly the generated subset', () => {
	expect(collections).toEqual(generateSubset());
});
it('bundles every source icon and uses only the offline renderer', () => {
	expect(() => checkSourceIcons(collections)).not.toThrow();
});
it.each(['phh:plus-duotone', 'ph:unknown-icon-duotone'])(
	'rejects missing icon %s in props and closed maps',
	(name) => {
		for (const [path, source] of [
			['Example.svelte', `<Icon icon="${name}" class="md:hidden" />`],
			['nav-items.ts', `const items = [{ icon: '${name}' }];`],
			['category-icons.ts', `const icons = { other: '${name}' };`],
			[
				'Calculator.svelte',
				`<script>import Icon from '@iconify/svelte/dist/OfflineIcon.svelte'; const OP_ICONS = { '+': '${name}' };</script>`
			]
		]) {
			expect(() => assertSubsetCoverage(collections, sourceIconNames(path, source))).toThrow(
				name
			);
		}
	}
);
it('ignores URLs, attributes and Tailwind variants outside icon sites', () => {
	expect(
		sourceIconNames(
			'Example.svelte',
			`<script>import Icon from '@iconify/svelte/dist/OfflineIcon.svelte'; const url = 'https://example.test';</script><Icon icon="ph:plus-duotone" class="md:hidden" aria-label="Add" /><div class="md:hidden" />`
		)
	).toEqual(['ph:plus-duotone']);
});
