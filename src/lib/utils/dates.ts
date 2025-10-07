export function encodeCursor(obj: { occurred_at: string; id: string }) {
	return btoa(JSON.stringify(obj));
}
export function decodeCursor(cursor: string): { occurred_at: string; id: string } {
	return JSON.parse(atob(cursor));
}

export function toISODateOnly(d: Date | string) {
	const date = typeof d === 'string' ? new Date(d) : d;
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}
