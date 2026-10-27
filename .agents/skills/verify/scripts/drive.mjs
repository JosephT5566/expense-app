#!/usr/bin/env node
// Drive one journey against the instance launch.sh started, with every
// non-local request mocked or blocked. Usage: drive.mjs <journey>
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const name = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
if (!name || !existsSync(join(here, 'journeys', `${name}.mjs`))) {
	console.error(`usage: drive.mjs <journey>; journeys live in ${join(here, 'journeys')}`);
	process.exit(2);
}
const statePath = join(process.env.TMPDIR ?? tmpdir(), 'expense-app-verify-4173.env');
if (!existsSync(statePath)) {
	console.error(`REFUSE: no ${statePath}. Run launch.sh, then doctor.sh.`);
	process.exit(2);
}
const state = Object.fromEntries(
	readFileSync(statePath, 'utf8')
		.trim()
		.split('\n')
		.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
);
const out = join(state.OUT, name);
mkdirSync(out, { recursive: true });
const journey = (await import(join(here, 'journeys', `${name}.mjs`))).default;

const local = new URL(state.URL).host;
const hosts = {
	supabase: new URL(state.SUPABASE).host,
	semantic: new URL(state.SEMANTIC).host,
	receipt: new URL(state.RECEIPT).host
};
const requests = [];
const errors = [];
const steps = [];
let browser;
let channel = 'playwright-chromium';
try {
	browser = await chromium.launch();
} catch (error) {
	if (!String(error).includes("Executable doesn't exist")) {
		throw error;
	}
	// No bundled Chromium: use installed Google Chrome with a throwaway profile.
	channel = 'chrome';
	browser = await chromium.launch({ channel });
}
const context = await browser.newContext({
	viewport: { width: 430, height: 900 },
	timezoneId: 'Asia/Taipei',
	locale: 'zh-TW',
	serviceWorkers: 'block'
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
await context.routeWebSocket(/.*/, (ws) => {
	requests.push({ method: 'WS', url: ws.url(), disposition: 'blocked' });
	ws.close();
});

const ctx = { page, state, hosts, out, mocks: journey.mocks ?? {} };
await context.route('**/*', async (route) => {
	const request = route.request();
	const url = new URL(request.url());
	const entry = { method: request.method(), url: request.url() };
	const kind = Object.keys(hosts).find((key) => hosts[key] === url.host);
	if (url.host === local) {
		entry.disposition = 'local';
		requests.push(entry);
		return route.continue();
	}
	const handler = kind && ctx.mocks[kind];
	const handled = handler ? await handler(route, url, request) : false;
	if (handled) {
		entry.disposition = 'mocked';
		entry.status = handled;
	} else if (kind) {
		entry.disposition = 'unmocked-error';
		await route.fulfill({ status: 501, json: { message: 'verify: no mock for this request' } });
	} else {
		entry.disposition = 'blocked';
		await route.abort('blockedbyclient');
	}
	requests.push(entry);
});

async function evidence(label) {
	writeFileSync(join(out, `${label}.aria.yml`), await page.locator('body').ariaSnapshot());
	await page.screenshot({ path: join(out, `${label}.png`) });
}
async function step(label, fn) {
	try {
		await fn();
		steps.push({ step: label, ok: true });
	} catch (error) {
		steps.push({ step: label, ok: false, error: String(error).split('\n')[0] });
		throw error;
	}
}

let ok = true;
try {
	await journey.run({ ...ctx, step, evidence });
	await step('no page errors', async () => {
		if (errors.length) {
			throw new Error(errors.join('; '));
		}
	});
} catch {
	ok = false;
	await evidence('failure').catch(() => {});
}
await browser.close();

// Nothing may be passed through except the local preview. A real
// *.supabase.co request here means the build was not the synthetic one.
const leaked = requests.filter((r) => r.disposition === 'local' && new URL(r.url).host !== local);
const realSupabase = requests.filter(
	(r) => r.method !== 'WS' && /\.supabase\.co$/.test(new URL(r.url).host)
);
if (leaked.length || realSupabase.length) {
	ok = false;
	steps.push({
		step: 'network isolation',
		ok: false,
		error: `${leaked.length} passthrough, ${realSupabase.length} to *.supabase.co (blocked)`
	});
} else {
	steps.push({ step: 'network isolation', ok: true });
}
const count = (d) => requests.filter((r) => r.disposition === d).length;
const summary = {
	journey: name,
	ok,
	browser: channel,
	url: state.URL,
	steps,
	pageErrors: errors,
	requests: {
		local: count('local'),
		mocked: count('mocked'),
		unmockedError: count('unmocked-error'),
		blocked: count('blocked')
	}
};
writeFileSync(
	join(out, 'requests.json'),
	JSON.stringify(
		requests.filter((r) => r.disposition !== 'local'),
		null,
		'\t'
	)
);
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, '\t'));
for (const s of steps) {
	console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step}${s.error ? ` — ${s.error}` : ''}`);
}
console.log(
	`${ok ? 'PASS' : 'FAIL'} ${name} (${channel}); requests ${JSON.stringify(summary.requests)}; evidence ${out}`
);
process.exit(ok ? 0 : 1);
