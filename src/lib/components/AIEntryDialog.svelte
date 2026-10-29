<script lang="ts">
	import * as Dialog from '$lib/components/shadcn/dialog';
	import { Button } from '$lib/components/shadcn/button';
	import X from 'lucide-svelte/icons/x';
	import SemanticEntryContent from './semantic-entry/SemanticEntryContent.svelte';

	let {
		open = $bindable(false)
	}: {
		open: boolean;
	} = $props();

	let semanticContent = $state<SemanticEntryContent>();
	let busy = $state(false);

	function requestClose() {
		semanticContent?.requestClose();
	}

	function changeOpen(next: boolean) {
		if (next) {
			open = true;
		} else {
			requestClose();
		}
	}
</script>

<Dialog.Root {open} onOpenChange={changeOpen}>
	<Dialog.Content
		class="sm:max-w-[425px] max-h-[90vh] overflow-hidden flex flex-col"
		showCloseButton={false}
		onInteractOutside={(event) => {
			event.preventDefault();
			requestClose();
		}}
		onEscapeKeydown={(event) => {
			event.preventDefault();
			requestClose();
		}}
	>
		{#if !busy}
			<Button
				variant="ghost"
				class="absolute right-2 top-2 h-8 w-8 p-0"
				onclick={requestClose}
			>
				<X class="h-4 w-4" />
				<span class="sr-only">Close</span>
			</Button>
		{/if}
		<Dialog.Header class="pr-8 text-left">
			<Dialog.Title>AI 記帳</Dialog.Title>
			<Dialog.Description class="sr-only">用文字或收據圖片新增支出。</Dialog.Description>
		</Dialog.Header>
		<div class="flex-1 overflow-y-auto px-1">
			<SemanticEntryContent
				bind:this={semanticContent}
				bind:busy
				onClose={() => (open = false)}
			/>
		</div>
	</Dialog.Content>
</Dialog.Root>
