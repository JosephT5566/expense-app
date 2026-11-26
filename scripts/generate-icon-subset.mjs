import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const usedIcons = [
	'logos:google-icon',
	'ph:airplane-duotone',
	'ph:arrow-clockwise-duotone',
	'ph:backspace-duotone',
	'ph:beer-bottle-duotone',
	'ph:book-open-duotone',
	'ph:bread-duotone',
	'ph:bus-duotone',
	'ph:calculator-duotone',
	'ph:calendar-dots-duotone',
	'ph:caret-up-duotone',
	'ph:carrot-duotone',
	'ph:chart-line-up-duotone',
	'ph:check-circle-duotone',
	'ph:cookie-duotone',
	'ph:divide-duotone',
	'ph:file-plus-duotone',
	'ph:game-controller-duotone',
	'ph:gift-duotone',
	'ph:hamburger-duotone',
	'ph:hand-heart-duotone',
	'ph:house-duotone',
	'ph:laptop-duotone',
	'ph:magnifying-glass-duotone',
	'ph:minus-duotone',
	'ph:note-pencil-duotone',
	'ph:person-simple-run-duotone',
	'ph:pill-duotone',
	'ph:pizza-duotone',
	'ph:plus-duotone',
	'ph:plus-minus-duotone',
	'ph:sign-out-duotone',
	'ph:sparkle-duotone',
	'ph:stack-simple-duotone',
	'ph:t-shirt-duotone',
	'ph:tag-duotone',
	'ph:toilet-paper-duotone',
	'ph:x-circle-duotone',
	'ph:x-duotone',
	'svg-spinners:90-ring-with-bg'
];

/** @returns {Record<string, import('@iconify/types').IconifyJSON>} */
export function generateSubset() {
	return Object.fromEntries(
		['ph', 'logos', 'svg-spinners'].map((prefix) => {
			/** @type {import('@iconify/types').IconifyJSON} */
			const collection = JSON.parse(
				readFileSync(
					new URL(`../node_modules/@iconify-json/${prefix}/icons.json`, import.meta.url),
					'utf8'
				)
			);
			/** @type {import('@iconify/types').IconifyJSON['icons']} */
			const icons = {};
			/** @type {NonNullable<import('@iconify/types').IconifyJSON['aliases']>} */
			const aliases = {};
			/** @param {string} name */
			function include(name) {
				if (icons[name] || aliases[name]) {
					return;
				}
				if (collection.icons[name]) {
					icons[name] = collection.icons[name];
				} else if (collection.aliases?.[name]) {
					aliases[name] = collection.aliases[name];
					include(aliases[name].parent);
				} else {
					throw new Error(`Missing icon: ${prefix}:${name}`);
				}
			}
			for (const name of usedIcons.filter((name) => name.startsWith(`${prefix}:`))) {
				include(name.slice(prefix.length + 1));
			}
			return [
				prefix,
				{
					prefix,
					...(collection.width === undefined ? {} : { width: collection.width }),
					...(collection.height === undefined ? {} : { height: collection.height }),
					icons,
					...(Object.keys(aliases).length ? { aliases } : {})
				}
			];
		})
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(
		new URL('../src/lib/icons/iconify-subset.json', import.meta.url),
		JSON.stringify(generateSubset(), null, '\t') + '\n'
	);
}
