import { writable } from 'svelte/store';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const ensureMinimumDuration = async (start: number, loadingMinMs: number) => {
	const elapsed = now() - start;
	if (elapsed < loadingMinMs) {
		await new Promise((resolve) => setTimeout(resolve, loadingMinMs - elapsed));
	}
};

type useAsyncActionProps = {
	loadingMinMs?: number;
	doneMinMs?: number;
};

export function useAsyncAction<T>({
	loadingMinMs = 2000,
	doneMinMs = 800,
}: useAsyncActionProps = {}) {
	const isLoading = writable(false);
	const isDone = writable(false);

	async function run(action: () => Promise<T>) {
		isLoading.set(true);
		isDone.set(false);

		const start = now();

		try {
			await action();
			await ensureMinimumDuration(start, loadingMinMs);
		} finally {
			isLoading.set(false);

			isDone.set(true);
			await new Promise((res) =>
				setTimeout(() => {
					isDone.set(false);
					res("action done");
				}, doneMinMs)
			);
		}
	}

	return {
		run,
		isLoading,
		isDone,
	};
}
