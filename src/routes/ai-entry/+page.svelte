<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/shadcn/button';
	import SemanticEntryContent from '$lib/components/semantic-entry/SemanticEntryContent.svelte';

	let content = $state<SemanticEntryContent>();
	let busy = $state(false);
	let previous = $state<URL>();
	afterNavigate(({ from }) => {
		if (from?.url && from.route.id !== '/ai-entry') {
			previous = from.url;
		}
	});
</script>

<svelte:head><title>AI 記帳 · JoPie</title></svelte:head>

<section class="mx-auto w-full max-w-xl space-y-4 p-4" aria-labelledby="ai-entry-title">
	<div class="flex items-center justify-between gap-2">
		<Button
			variant="ghost"
			onclick={() => {
				if (previous) {
					// The previous SvelteKit URL already includes the deployment base path.
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					void goto(previous);
				} else {
					void goto(resolve('/'));
				}
			}}>返回</Button
		>
		<Button variant="outline" disabled={busy} onclick={() => content?.startNewConversation()}
			>新對話</Button
		>
	</div>
	<SemanticEntryContent bind:this={content} bind:busy />
</section>
