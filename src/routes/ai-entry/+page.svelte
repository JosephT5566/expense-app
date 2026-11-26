<script lang="ts">
	import { Button } from '$lib/components/shadcn/button';
	import SemanticEntryContent from '$lib/components/semantic-entry/SemanticEntryContent.svelte';

	let content = $state<SemanticEntryContent>();
	let busy = $state(false);
</script>

<svelte:head><title>AI 記帳 · JoPie</title></svelte:head>

<section class="mx-auto w-full max-w-xl space-y-4 p-4" aria-labelledby="ai-entry-title">
	<div class="flex items-center justify-end gap-2">
		<Button variant="outline" disabled={busy} onclick={() => content?.startNewConversation()}
			>新對話</Button
		>
	</div>
	<SemanticEntryContent bind:this={content} bind:busy />
</section>
