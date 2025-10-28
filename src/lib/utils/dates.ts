export function encodeCursor(obj: { ts: string; id: string }) {
	return btoa(JSON.stringify(obj));
}
export function decodeCursor(cursor: string): { ts: string; id: string } {
	return JSON.parse(atob(cursor));
}

export function toISODateOnly(d: Date | string) {
	const date = typeof d === 'string' ? new Date(d) : d;
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function toTaiwanDateString(d: Date | string) {
	const date = typeof d === 'string' ? new Date(d) : d;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

// 新增：計算「台灣時區（UTC+8）」的單日 UTC 邊界
// 輸入：YYYY-MM-DD（台灣當地日期）
// 輸出：對應的 UTC ISO 範圍（[from, to] 皆為含端點）
export function taiwanDayBoundsISO(dateStr: string) {
	const [y, m, d] = dateStr.split('-').map(Number);
	// 台灣 00:00 (+08:00) => UTC 前一日 16:00
	const from = new Date(Date.UTC(y, m - 1, d, -8, 0, 0, 0));
	// 台灣 23:59:59.999 (+08:00) => UTC 當日 15:59:59.999
	const to = new Date(Date.UTC(y, m - 1, d, 15, 59, 59, 999));
	return { from: from.toISOString(), to: to.toISOString() };
}

// 新增：計算「台灣時區（UTC+8）」的月份 UTC 邊界
// 輸入：year, month（1-12）指台灣當地年月
export function taiwanMonthBoundsISO(year: number, month: number) {
	// 月初台灣 00:00 (+08:00) => UTC 前一日 16:00
	const start = new Date(Date.UTC(year, month - 1, 1, -8, 0, 0, 0));
	// 月末台灣 23:59:59.999 (+08:00) => UTC 月末 15:59:59.999
	const end = new Date(Date.UTC(year, month, 0, 15, 59, 59, 999));
	return { from: start.toISOString(), to: end.toISOString() };
}

export function getTaiwanDate(tsUTC: string) {
	const date = new Date(tsUTC);
	const year = date.getFullYear();
	const month = date.getMonth() + 1;
	const day = date.getDate();
	return { year, month, day };
}

export function getTaiwanMonthKey(tsUTC?: string) {
	const date = tsUTC ? new Date(tsUTC) : new Date();
	const taiwanNow = new Date(date.getTime() + 8 * 60 * 60 * 1000); // UTC+8
	const year = taiwanNow.getUTCFullYear();
	const month = String(taiwanNow.getUTCMonth() + 1).padStart(2, '0');
	return `${year}-${month}`; // 'YYYY-MM'
}

export function decodeMonthKey(monthKey: string) {
	const [y, m] = monthKey.split('-').map(Number);
	return { year: y, month: m };
}
