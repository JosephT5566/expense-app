import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
	'ph:chat-circle-dots-duotone',
	'ph:check-circle-duotone',
	'ph:clock-duotone',
	'ph:cookie-duotone',
	'ph:divide-duotone',
	'ph:file-plus-duotone',
	'ph:game-controller-duotone',
	'ph:gift-duotone',
	'ph:hamburger-duotone',
	'ph:hand-heart-duotone',
	'ph:hourglass-duotone',
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

/** @param {string} path @param {string} source */
export function sourceIconNames(path, source) {
	const scripts = path.endsWith('.svelte')
		? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
				.map((match) => match[1])
				.join('\n')
		: source;
	const isMap = /(?:^|[/\\])(?:nav-items|category-icons)\.ts$/.test(path);
	const literals = [...source.matchAll(/<Icon\b[^>]*>/g)]
		.flatMap((tag) =>
			[...tag[0].matchAll(/\bicon\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g)].map(
				(match) => match[1]
			)
		)
		.join('\n');
	const sites =
		literals +
		'\n' +
		(isMap || /from ['"]@iconify\/svelte(?:\/[^'"]*)?['"]/.test(scripts) ? scripts : '');
	return [...sites.matchAll(/(['"`])([a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*)\1/g)].map(
		(match) => match[2]
	);
}

/** @param {Record<string, import('@iconify/types').IconifyJSON>} collections
 * @param {string[]} names
 */
export function assertSubsetCoverage(collections, names) {
	for (const fullName of names) {
		const [prefix, name] = fullName.split(':');
		if (!collections[prefix]?.icons[name] && !collections[prefix]?.aliases?.[name]) {
			throw new Error(`Missing source icon in subset: ${fullName}`);
		}
	}
}

/** @param {Record<string, import('@iconify/types').IconifyJSON>} collections
 * @param {string} dir
 */
export function checkSourceIcons(
	collections,
	dir = fileURLToPath(new URL('../src', import.meta.url))
) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			checkSourceIcons(collections, path);
		} else if (/\.(svelte|ts|js)$/.test(path) && !/\.test\.[tj]s$/.test(path)) {
			const source = readFileSync(path, 'utf8');
			if (
				/(?:solar|mdi):|from ['"]@iconify\/svelte['"]|@iconify-json\/.*icons\.json/.test(
					source
				)
			) {
				throw new Error(`Non-offline icon source: ${path}`);
			}
			assertSubsetCoverage(collections, sourceIconNames(path, source));
		}
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const subsetUrl = new URL('../src/lib/icons/iconify-subset.json', import.meta.url);
	const generated = JSON.stringify(generateSubset(), null, '\t') + '\n';
	if (process.argv.includes('--check')) {
		if (readFileSync(subsetUrl, 'utf8') !== generated) {
			throw new Error('Committed icon subset differs; run npm run icons:subset');
		}
		checkSourceIcons(JSON.parse(generated));
	} else {
		writeFileSync(subsetUrl, generated);
	}
}
