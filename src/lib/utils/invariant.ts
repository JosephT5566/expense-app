export function invariant(condition: unknown, msg = 'Invariant violation'): asserts condition {
	if (!condition) throw new Error(msg);
}
