// 中文類別名稱 -> Iconify (MDI) 圖示名稱
// 你可以依喜好微調每個圖示對應
export const CATEGORY_ICON_BY_NAME: Record<string, string> = {
  '早餐': 'mdi:bread-slice',
  '午餐': 'mdi:food-fork-drink',
  '晚餐': 'mdi:silverware-fork-knife',
  '飲料': 'mdi:cup-water',
  '食材': 'mdi:food-apple',
  '其他零食': 'mdi:candy-outline',
  '交通': 'mdi:bus',
  '日用品': 'mdi:toilet-paper-outline',
  '娛樂': 'mdi:gamepad-variant-outline',
  '衣物': 'mdi:tshirt-crew-outline',
  '居家相關': 'mdi:home-outline',
  '學習': 'mdi:school-outline',
  '3C': 'mdi:laptop',
  '送禮': 'mdi:gift-outline',
  '醫藥': 'mdi:pill',
  '出遊': 'mdi:airplane',
};

export const CATEGORY_ICON_FALLBACK = 'mdi:tag-outline';

export function getCategoryIcon(name: string): string {
  return CATEGORY_ICON_BY_NAME[name] ?? CATEGORY_ICON_FALLBACK;
}
