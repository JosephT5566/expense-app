<script lang="ts">
	import type { Draft } from '@jopie/semantic-entry-contract';
	import { Button } from '$lib/components/shadcn/button';
	import { expenseOptions } from '$lib/stores/categories.store';
	import Pencil from 'lucide-svelte/icons/pencil';
	import Sparkles from 'lucide-svelte/icons/sparkles';
	import { draftAmount, draftSummary, isComplete, issueText } from './drafts';
	let {
		drafts,
		editedIds,
		disabled,
		onEditDrafts,
		onCommit
	}: {
		drafts: Draft[];
		editedIds: string[];
		disabled: boolean;
		onEditDrafts: () => void;
		onCommit: () => void;
	} = $props();
	const complete = $derived(drafts.filter(isComplete).length);
</script>

<div role="group" aria-label="草稿" class="space-y-3 rounded-xl border bg-card p-3">
	<div class="flex flex-wrap items-center justify-between gap-2 font-medium">
		<span>草稿 {drafts.length} 筆（尚未記帳）</span><span class="text-xs text-muted-foreground"
			>完整 {complete}／{drafts.length}</span
		>
	</div>
	<div role="list" class="divide-y">
		{#each drafts as draft (draft.draftId)}
			<div role="listitem" class="space-y-2 py-3">
				<div class="flex items-start justify-between gap-3">
					<p class="min-w-0 break-words">
						{draft.note.value ?? '未命名帳目'}{draft.mergedFrom &&
						draft.mergedFrom.length >= 2
							? ` 等 ${draft.mergedFrom.length} 項`
							: ''}
					</p>
					<p
						class:text-destructive={draft.currency.value !== 'TWD' ||
							draft.amount.value === null}
						class="shrink-0"
					>
						{draftAmount(draft)}
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span
						>{draft.date.value
							? draft.date.value.slice(5).replace('-', '/')
							: '日期未定'} · {draft.scope.value === 'household'
							? '家庭・平分'
							: draft.scope.value === 'personal'
								? '個人'
								: '範圍未定'}</span
					>
					<span
						class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5"
						class:border-dashed={draft.categoryId.value === null}
					>
						{#if draft.categoryId.value !== null && ['image', 'text'].includes(draft.categoryId.source)}<Sparkles
								class="h-3 w-3"
								aria-hidden="true"
							/>{/if}
						{draft.categoryId.value === null
							? '分類未選'
							: ($expenseOptions.find(
									(option) => option.value === draft.categoryId.value
								)?.label ?? '分類已不存在')}
					</span>
					{#if isComplete(draft)}<span
							class="rounded bg-green-500/10 px-1.5 py-0.5 text-green-700 dark:text-green-400"
							>✓ 完整</span
						>{/if}
					{#if draft.issues.some((issue) => issue.code === 'non_twd')}<span
							class="text-destructive">非 TWD</span
						>{/if}
					{#if (draft.mergedFrom?.length ?? 0) >= 2}<span>已合併</span>{/if}
					{#if draft.updated || editedIds.includes(draft.draftId)}<span>剛更新</span>{/if}
				</div>
				{#if !isComplete(draft)}<p class="text-xs text-destructive">
						{draft.issues.map(issueText).join('、')}
					</p>{/if}
			</div>
		{/each}
	</div>
	<p class="text-xs text-muted-foreground">{draftSummary(drafts)}</p>
	<div class="flex flex-wrap gap-2">
		<Button size="sm" variant="outline" {disabled} onclick={onEditDrafts}
			><Pencil class="h-4 w-4" aria-hidden="true" />進入編輯</Button
		><Button
			size="sm"
			disabled={disabled || !drafts.length || complete !== drafts.length}
			onclick={onCommit}>全部記帳（{drafts.length} 筆）</Button
		>
	</div>
</div>
