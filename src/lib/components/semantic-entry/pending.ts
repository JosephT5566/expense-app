export const PENDING_EXPIRY_MS = 600_000;
export const PENDING_LIMIT = 3;
export const SNIPPET_LENGTH = 12;

export type PendingKind = 'analyze' | 'commit' | 'legacy';
export type PendingItem = {
	requestId: string;
	submittedAt: number | null;
	kind: PendingKind;
	snippet?: string;
	imageCount?: number;
	draftCount?: number;
	expiredAt: number | null;
};
export type PendingStore = { v: 2; items: PendingItem[] };
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const pendingKey = (owner: string) => `jopie:semantic-pending:${owner}`;

// Match the requestId boundary in the semantic-entry contract without importing browser code.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}
function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseItem(raw: unknown): PendingItem | null {
	if (
		!object(raw) ||
		typeof raw.requestId !== 'string' ||
		!uuid.test(raw.requestId) ||
		(raw.kind !== 'analyze' && raw.kind !== 'commit' && raw.kind !== 'legacy') ||
		(raw.expiredAt !== null && !finite(raw.expiredAt)) ||
		(raw.kind === 'legacy'
			? raw.submittedAt !== null || !finite(raw.expiredAt)
			: !finite(raw.submittedAt)) ||
		('snippet' in raw &&
			(typeof raw.snippet !== 'string' || [...raw.snippet].length > SNIPPET_LENGTH)) ||
		('imageCount' in raw && !count(raw.imageCount)) ||
		('draftCount' in raw && !count(raw.draftCount))
	) {
		return null;
	}
	return {
		requestId: raw.requestId,
		submittedAt: finite(raw.submittedAt) ? raw.submittedAt : null,
		kind: raw.kind,
		...(raw.kind === 'analyze' && typeof raw.snippet === 'string'
			? { snippet: raw.snippet }
			: {}),
		...(raw.kind === 'analyze' && count(raw.imageCount) ? { imageCount: raw.imageCount } : {}),
		...(raw.kind === 'commit' && count(raw.draftCount) ? { draftCount: raw.draftCount } : {}),
		expiredAt: raw.expiredAt
	};
}

export function parsePending(
	raw: unknown,
	now: number
): { items: PendingItem[]; migrated: boolean } {
	if (!object(raw)) {
		return { items: [], migrated: false };
	}
	if (!('v' in raw)) {
		return typeof raw.requestId === 'string' && uuid.test(raw.requestId)
			? {
					items: [
						{
							requestId: raw.requestId,
							submittedAt: null,
							kind: 'legacy',
							expiredAt: now
						}
					],
					migrated: true
				}
			: { items: [], migrated: false };
	}
	if (raw.v !== 2 || !Array.isArray(raw.items)) {
		return { items: [], migrated: false };
	}
	const seen = new Set<string>();
	const items: PendingItem[] = [];
	for (const value of raw.items) {
		const item = parseItem(value);
		if (item && !seen.has(item.requestId)) {
			seen.add(item.requestId);
			items.push(item);
		}
	}
	return { items, migrated: false };
}

function unchanged(raw: unknown, items: PendingItem[]): boolean {
	if (!object(raw) || Object.keys(raw).length !== 2 || raw.v !== 2 || !Array.isArray(raw.items)) {
		return false;
	}
	const original: unknown[] = raw.items;
	return (
		original.length === items.length &&
		items.every((item, index) => {
			const value = original[index];
			return (
				object(value) &&
				Object.keys(value).length === Object.keys(item).length &&
				Object.entries(item).every(([key, field]) => value[key] === field)
			);
		})
	);
}

export function load(
	owner: string,
	now: number,
	storage: PendingStorage = globalThis.localStorage
): PendingItem[] {
	const stored = storage.getItem(pendingKey(owner));
	if (stored === null) {
		return [];
	}
	let raw: unknown;
	try {
		raw = JSON.parse(stored);
	} catch {
		raw = null;
	}
	const { items, migrated } = parsePending(raw, now);
	if (migrated || !unchanged(raw, items)) {
		save(owner, items, storage);
	}
	return items;
}

export function save(
	owner: string,
	items: PendingItem[],
	storage: PendingStorage = globalThis.localStorage
): void {
	// Rebuild the allowlist even for typed callers so extra runtime fields cannot reach storage.
	const clean = parsePending({ v: 2, items }, Date.now()).items;
	if (!clean.length) {
		storage.removeItem(pendingKey(owner));
	} else {
		storage.setItem(
			pendingKey(owner),
			JSON.stringify({ v: 2, items: clean } satisfies PendingStore)
		);
	}
}

export function add(
	owner: string,
	item: PendingItem,
	now: number,
	storage: PendingStorage = globalThis.localStorage
): PendingItem[] | false {
	const items = load(owner, now, storage);
	const clean = parseItem(item);
	if (!clean || items.some((existing) => existing.requestId === clean.requestId)) {
		return false;
	}
	const next = [...items, clean];
	save(owner, next, storage);
	return next;
}

export function markExpired(
	owner: string,
	requestId: string,
	now: number,
	storage: PendingStorage = globalThis.localStorage
): PendingItem[] {
	const items = load(owner, now, storage).map((item) =>
		item.requestId === requestId && item.expiredAt === null ? { ...item, expiredAt: now } : item
	);
	save(owner, items, storage);
	return items;
}

export function remove(
	owner: string,
	requestId: string,
	storage: PendingStorage = globalThis.localStorage
): PendingItem[] {
	const items = load(owner, Date.now(), storage).filter((item) => item.requestId !== requestId);
	save(owner, items, storage);
	return items;
}

export function removeSeenExpired(
	owner: string,
	seenIds: Iterable<string>,
	storage: PendingStorage = globalThis.localStorage
): PendingItem[] {
	const seen = new Set(seenIds);
	const items = load(owner, Date.now(), storage).filter(
		(item) => item.expiredAt === null || !seen.has(item.requestId)
	);
	save(owner, items, storage);
	return items;
}

export const activeCount = (items: PendingItem[]) =>
	items.filter((item) => item.expiredAt === null).length;

// Legacy items are already expired and have no submission window.
export const isPastWindow = (item: PendingItem, now: number) =>
	item.submittedAt !== null &&
	now >= item.submittedAt &&
	now - item.submittedAt >= PENDING_EXPIRY_MS;

export function snippetOf(text: string): string | undefined {
	return [...text.trim()].slice(0, SNIPPET_LENGTH).join('') || undefined;
}
