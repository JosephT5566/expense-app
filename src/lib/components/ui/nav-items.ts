export type Tab = 'add' | 'summary' | 'setting';
type NavPath = '/' | '/summary' | '/setting';

export const items: { key: Tab; label: string; path: NavPath; icon: string }[] = [
	{ key: 'add', label: '新增', path: '/', icon: 'solar:document-add-bold-duotone' },
	{ key: 'summary', label: '統計', path: '/summary', icon: 'solar:graph-up-bold-duotone' },
	{
		key: 'setting',
		label: '更多功能',
		path: '/setting',
		icon: 'solar:layers-minimalistic-bold-duotone'
	}
];

export function matchNavTab(
	routeId: string | null
): { tab: Tab; current: 'page' | 'true' } | undefined {
	const item = items.find((item) => item.path === routeId);
	if (item) {
		return { tab: item.key, current: 'page' };
	}

	switch (routeId) {
		case '/settle':
		case '/search':
		case '/scheduled':
			return { tab: 'setting', current: 'true' };
		default:
			return undefined;
	}
}
