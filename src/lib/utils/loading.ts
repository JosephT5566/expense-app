/**
 * Runs the provided async action while toggling a loading state and ensuring
 * the indicator stays visible for at least `minDuration` milliseconds.
 *
 * @param action Async function to execute.
 * @param setLoading Callback invoked with the loading state.
 * @param minDuration Minimum time in milliseconds to keep the loading state true.
 */
export async function withMinimumLoading<T>(
	action: () => Promise<T>,
	setLoading: (value: boolean) => void,
	minDuration = 2000
): Promise<T> {
	const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
	const start = now();

	const ensureMinimumDuration = async () => {
		const elapsed = now() - start;
		if (elapsed < minDuration) {
			await new Promise((resolve) => setTimeout(resolve, minDuration - elapsed));
		}
	};

	setLoading(true);
	try {
		const result = await action();
		await ensureMinimumDuration();
		return result;
	} catch (error) {
		await ensureMinimumDuration();
		throw error;
	} finally {
		setLoading(false);
	}
}

/**
 * Temporarily toggles a flag to true and then resets it after `duration`
 * milliseconds. Returns a cleanup function that cancels the pending reset and
 * immediately sets the flag back to false.
 */
export function withTemporaryFlag(
	setFlag: (value: boolean) => void,
	duration = 1200
): () => void {
	let active = true;
	setFlag(true);

	const timeout = setTimeout(() => {
		if (!active) {
			return;
		}
		active = false;
		setFlag(false);
	}, duration);

	return () => {
		if (!active) {
			return;
		}
		active = false;
		clearTimeout(timeout);
		setFlag(false);
	};
}
