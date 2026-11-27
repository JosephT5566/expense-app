import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const output = 'build';
const base = (process.env.BASE_PATH ?? '').replace(/\/$/, '');
const origin = 'https://jopie-build.invalid';
const home = new URL(`${base}/`, origin);
const files = new Map(
	readdirSync(output, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			return [relative(output, path), statSync(path).size];
		})
);

function outputPath(href) {
	const url = new URL(href, home);
	if (url.origin !== origin || !url.pathname.startsWith(home.pathname)) {
		return undefined;
	}
	const path = decodeURIComponent(url.pathname.slice(home.pathname.length));
	return [path, `${path}.html`, join(path, 'index.html')].find((candidate) =>
		files.has(candidate)
	);
}

function size(paths, compress = false) {
	let raw = 0;
	let gzip = 0;
	for (const path of paths) {
		raw += files.get(path);
		if (compress) {
			gzip += gzipSync(readFileSync(join(output, path))).length;
		}
	}
	return { raw, gzip };
}

function kib(bytes) {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

const document = readFileSync(join(output, 'index.html'), 'utf8');
const initial = new Set();
for (const [tag] of document.matchAll(/<link\s+[^>]*>/gi)) {
	const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1];
	const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
	if (href && (rel === 'modulepreload' || rel === 'stylesheet')) {
		const path = outputPath(href);
		if (path?.match(/\.(js|css)$/)) {
			initial.add(path);
		}
	}
}
if (!initial.size) {
	throw new Error('No initial JS or CSS assets found in build/index.html.');
}

const clientFiles = [...files.keys()].filter(
	(path) => path.startsWith('_app/') && /\.(js|css)$/.test(path)
);
const initialSize = size(initial, true);
const clientSize = size(clientFiles, true);
const siteSize = size(files.keys());
const manifest = JSON.parse(readFileSync('.svelte-kit/output/client/.vite/manifest.json', 'utf8'));
const lazyChunks = Object.values(manifest)
	.filter(
		(entry) => entry.isDynamicEntry && entry.file.endsWith('.js') && !initial.has(entry.file)
	)
	.sort((left, right) => files.get(right.file) - files.get(left.file))
	.slice(0, 5);

const lines = [
	'## GitHub Pages build',
	'',
	`Base path \`${home.pathname}\``,
	'',
	'| Output | Files | Raw | Gzip estimate |',
	'| --- | ---: | ---: | ---: |',
	`| Initial home JS and CSS | ${initial.size} | ${kib(initialSize.raw)} | ${kib(initialSize.gzip)} |`,
	`| All client JS and CSS | ${clientFiles.length} | ${kib(clientSize.raw)} | ${kib(clientSize.gzip)} |`,
	`| Complete Pages output | ${files.size} | ${kib(siteSize.raw)} | — |`
];

if (files.has('sw.js')) {
	const worker = readFileSync(join(output, 'sw.js'), 'utf8');
	const entries = worker.match(/\.precacheAndRoute\(\s*\[([^\]]*)\]/)?.[1] ?? '';
	const urls = [...entries.matchAll(/\burl\s*:\s*("(?:[^"\\]|\\.)*")/g)].map(([, url]) =>
		JSON.parse(url)
	);
	const paths = urls.map(outputPath);
	if (paths.length && paths.every(Boolean)) {
		const precache = new Set(paths);
		lines.push(`| PWA precache | ${precache.size} | ${kib(size(precache).raw)} | — |`);
	} else {
		lines.push('| PWA precache | — | Unavailable | — |');
	}
}

if (lazyChunks.length) {
	lines.push(
		'',
		'### Largest lazy chunks',
		'',
		'| Chunk | Raw | Gzip estimate |',
		'| --- | ---: | ---: |'
	);
	for (const entry of lazyChunks) {
		const chunkSize = size([entry.file], true);
		lines.push(`| \`${entry.name}\` | ${kib(chunkSize.raw)} | ${kib(chunkSize.gzip)} |`);
	}
}

lines.push(
	'',
	'Initial assets are the local module preloads and stylesheets in the generated home HTML. The precache can include lazy chunks.',
	''
);
const markdown = lines.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
} else {
	process.stdout.write(markdown);
}
