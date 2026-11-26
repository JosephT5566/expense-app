<script lang="ts">
	import { restoredImageUrls, requestImageUrls } from '$lib/data/semantic-entry.fetcher';
	import type { ReadImageTarget } from '@jopie/semantic-entry-contract';
	let { paths }: { paths: string[] } = $props();
	let images = $state<Map<string, ReadImageTarget>>(new Map());
	let retried: string[] = [];
	let controller: AbortController;
	$effect(() => {
		const current = new AbortController();
		controller = current;
		images = new Map();
		retried = [];
		void restoredImageUrls(paths, current.signal).then((result) => {
			if (!current.signal.aborted) {
				images = result;
			}
		});
		return () => current.abort();
	});
	async function failed(path: string) {
		const current = controller;
		images = new Map([...images].filter(([key]) => key !== path));
		if (retried.includes(path)) {
			return;
		}
		retried.push(path);
		try {
			const [image] = await requestImageUrls([path], current.signal);
			if (!current.signal.aborted) {
				images = new Map([...images, [path, image]]);
			}
		} catch {
			// Keep the placeholder when signing fails or the object no longer exists.
		}
	}
</script>

{#each paths as path, i (i)}
	{@const image = images.get(path)}
	{#if image}
		<img
			src={image.url}
			alt="收據圖片"
			class="h-12 w-12 rounded-lg object-cover"
			onerror={() => failed(path)}
		/>
	{:else}
		<div
			role="img"
			aria-label="收據圖片，圖片暫時無法顯示"
			class="rounded-lg bg-muted p-3 text-xs text-muted-foreground"
		>
			收據圖片<br />圖片暫時無法顯示
		</div>
	{/if}
{/each}
