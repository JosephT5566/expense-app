import { expect, it } from 'vitest';
import { navPathsMatch } from './nav';

it.each([
	['/', '/'],
	['/expense-app/', '/expense-app'],
	['/expense-app/', '/expense-app/'],
	['/summary', '/summary/'],
	['/expense-app/summary', '/expense-app/summary'],
	['/expense-app/summary', '/expense-app/summary/'],
	['/expense-app/setting', '/expense-app/setting']
])('matches resolved path %s to %s', (resolvedPath, pathname) => {
	expect(navPathsMatch(resolvedPath, pathname)).toBe(true);
});

it.each(['/settle', '/search', '/scheduled', '/summary/details', '/summary-other'])(
	'does not match an unrelated route %s to a navigation item',
	(pathname) => {
		for (const base of ['', '/expense-app']) {
			for (const item of ['/', '/summary', '/setting']) {
				expect(navPathsMatch(`${base}${item}`, `${base}${pathname}`)).toBe(false);
			}
		}
	}
);

it('requires the base path to match', () => {
	expect(navPathsMatch('/summary', '/expense-app/summary')).toBe(false);
});
