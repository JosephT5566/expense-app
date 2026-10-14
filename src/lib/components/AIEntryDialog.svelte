<script lang="ts">
	import type { ExpenseRow } from '$lib/types/expense';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import { Button } from '$lib/components/shadcn/button';
	import Image from 'lucide-svelte/icons/image';
	import Text from 'lucide-svelte/icons/text';
	import X from 'lucide-svelte/icons/x';
	import SemanticEntryContent from './semantic-entry/SemanticEntryContent.svelte';
	import ReceiptImportContent from './ai-receipt/ReceiptImportContent.svelte';

	let {
		open = $bindable(false),
		onImport
	}: {
		open: boolean;
		onImport?: (expenses: ExpenseRow[]) => void;
	} = $props();

	let mode = $state<'semantic' | 'image'>('semantic');
	let semanticContent = $state<SemanticEntryContent>();
	let receiptContent = $state<ReceiptImportContent>();
	let semanticBusy = $state(false);
	let receiptBusy = $state(false);
	const busy = $derived(semanticBusy || receiptBusy);

	$effect(() => {
		if (!open) {
			mode = 'semantic';
		}
	});

	function closeDialog() {
		semanticContent?.requestClose();
	}

	function requestClose() {
		if (!busy) {
			receiptContent?.requestClose();
		}
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
		<Dialog.Header class="sr-only">
			<Dialog.Title>{mode === 'semantic' ? '文字記帳' : '圖片分析'}</Dialog.Title>
			<Dialog.Description>選擇文字記帳或圖片分析新增支出。</Dialog.Description>
		</Dialog.Header>
		<div
			class="flex w-fit gap-1 rounded-lg bg-muted p-1 mr-8"
			role="group"
			aria-label="AI 記帳模式"
		>
			<Button
				variant={mode === 'semantic' ? 'default' : 'ghost'}
				size="icon"
				aria-label="文字記帳"
				title="文字記帳"
				aria-pressed={mode === 'semantic'}
				disabled={busy}
				onclick={() => (mode = 'semantic')}
			>
				<Text class="h-4 w-4" aria-hidden="true" />
			</Button>
			<Button
				variant={mode === 'image' ? 'default' : 'ghost'}
				size="icon"
				aria-label="圖片分析"
				title="圖片分析"
				aria-pressed={mode === 'image'}
				disabled={busy}
				onclick={() => (mode = 'image')}
			>
				<Image class="h-4 w-4" aria-hidden="true" />
			</Button>
		</div>
		<div class="flex-1 overflow-y-auto px-1" hidden={mode !== 'semantic'}>
			<SemanticEntryContent
				bind:this={semanticContent}
				bind:busy={semanticBusy}
				onClose={() => (open = false)}
			/>
		</div>
		<div class="flex-1 overflow-y-auto px-1" hidden={mode !== 'image'}>
			<ReceiptImportContent
				bind:this={receiptContent}
				bind:busy={receiptBusy}
				{open}
				{onImport}
				onClose={closeDialog}
			/>
		</div>
	</Dialog.Content>
</Dialog.Root>
