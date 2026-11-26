import { describe, expect, it } from 'vitest';
import { items, matchNavTab } from './nav-items';

describe('navigation items', () => {
	it('preserves tab ids, labels, paths, and icons', () => {
		expect(items).toEqual([
			{ key: 'add', label: '新增', path: '/', icon: 'solar:document-add-bold-duotone' },
			{
				key: 'ai-entry',
				label: 'AI 記帳',
				path: '/ai-entry',
				icon: 'solar:chat-round-dots-bold-duotone'
			},
			{
				key: 'summary',
				label: '統計',
				path: '/summary',
				icon: 'solar:graph-up-bold-duotone'
			},
			{
				key: 'setting',
				label: '更多功能',
				path: '/setting',
				icon: 'solar:layers-minimalistic-bold-duotone'
			}
		]);
	});
});

describe('matchNavTab', () => {
	it.each([
		['/', 'add'],
		['/ai-entry', 'ai-entry'],
		['/summary', 'summary'],
		['/setting', 'setting']
	])('marks %s as the current page', (routeId, tab) => {
		expect(matchNavTab(routeId)).toEqual({ tab, current: 'page' });
	});

	it.each(['/settle', '/search', '/scheduled'])(
		'matches %s to the setting section',
		(routeId) => {
			expect(matchNavTab(routeId)).toEqual({ tab: 'setting', current: 'true' });
		}
	);

	it.each([null, '/sentry-example-page', '/summary/details'])(
		'leaves %s without a current tab',
		(routeId) => {
			expect(matchNavTab(routeId)).toBeUndefined();
		}
	);

	it.each(['/settle', '/search', '/scheduled', '/ai-entry/details'])(
		'does not select AI entry for non-tab route %s',
		(routeId) => {
			expect(matchNavTab(routeId)?.tab).not.toBe('ai-entry');
		}
	);
});
