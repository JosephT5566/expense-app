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
	minDuration = 400
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
