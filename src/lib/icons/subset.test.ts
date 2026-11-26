import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import collections from './iconify-subset.json';
import type { IconifyJSON } from '@iconify/svelte/dist/OfflineIcon.svelte';
const sets: Record<string, IconifyJSON> = collections;
import { generateSubset } from '../../../scripts/generate-icon-subset.mjs';

it('commits exactly the generated subset', () => {
	expect(collections).toEqual(generateSubset());
});
it('bundles every source icon and uses only the offline renderer', () => {
	const names = new Set(
		Object.values(sets).flatMap((set) =>
			[...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})].map(
				(name) => `${set.prefix}:${name}`
			)
		)
	);
	function scan(dir: string) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				scan(path);
			} else if (/\.(svelte|ts|js)$/.test(path) && !path.endsWith('.test.ts')) {
				const source = readFileSync(path, 'utf8');
				expect(source, path).not.toMatch(/(?:solar|mdi):/);
				expect(source, path).not.toMatch(/from ['"]@iconify\/svelte['"]/);
				expect(source, path).not.toMatch(/@iconify-json\/.*icons\.json/);
				for (const match of source.matchAll(
					/['"`]((?:ph|logos|svg-spinners):[a-z0-9-]+)['"`]/g
				)) {
					expect(names.has(match[1]), `${path}: ${match[1]}`).toBe(true);
				}
			}
		}
	}
	scan(resolve('src'));
});
