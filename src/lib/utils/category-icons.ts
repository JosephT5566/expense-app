// 中文類別名稱 -> Iconify (Phosphor duotone) 圖示名稱
// 你可以依喜好微調每個圖示對應
export const CATEGORY_ICON_BY_NAME: Record<string, string> = {
	早餐: 'ph:bread-duotone',
	午餐: 'ph:hamburger-duotone',
	晚餐: 'ph:pizza-duotone',
	飲料: 'ph:beer-bottle-duotone',
	食材: 'ph:carrot-duotone',
	其他零食: 'ph:cookie-duotone',
	交通: 'ph:bus-duotone',
	日用品: 'ph:toilet-paper-duotone',
	娛樂: 'ph:game-controller-duotone',
	衣物: 'ph:t-shirt-duotone',
	居家相關: 'ph:house-duotone',
	學習: 'ph:book-open-duotone',
	'3C': 'ph:laptop-duotone',
	送禮: 'ph:gift-duotone',
	醫藥: 'ph:pill-duotone',
	出遊: 'ph:airplane-duotone',
	運動: 'ph:person-simple-run-duotone'
};

export const CATEGORY_ICON_FALLBACK = 'ph:tag-duotone';

export function getCategoryIcon(name: string): string {
	return CATEGORY_ICON_BY_NAME[name] ?? CATEGORY_ICON_FALLBACK;
}
