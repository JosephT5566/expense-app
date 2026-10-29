<script lang="ts">
	import type { Draft } from '@jopie/semantic-entry-contract';
	import { Button } from '$lib/components/shadcn/button';
	import { Checkbox } from '$lib/components/shadcn/checkbox';
	import { expenseOptions } from '$lib/stores/categories.store';
	import { Eye, EyeOff, Pencil, Ungroup, Sparkles } from 'lucide-svelte';
	import { draftAmount, isComplete } from './drafts';
	let {
		draft,
		index,
		hidden = false,
		edited = false,
		grouped = false,
		summary = false,
		color,
		selecting = false,
		selected = false,
		onSelect,
		onToggle,
		onUngroup,
		onEdit
	}: {
		draft: Draft;
		index: number;
		hidden?: boolean;
		edited?: boolean;
		grouped?: boolean;
		summary?: boolean;
		color?: string;
		selecting?: boolean;
		selected?: boolean;
		onSelect?: () => void;
		onToggle?: () => void;
		onUngroup?: () => void;
		onEdit: () => void;
	} = $props();
	const date = $derived(draft.date.value?.split('-').slice(1).map(Number).join('/'));
</script>

<div class="flex items-stretch gap-1" data-draft-card={summary ? 'summary' : 'item'}>
	{#if !selecting}<Button
			variant="ghost"
			size="icon"
			class="h-7 w-7 shrink-0"
			title={summary ? '解除合併' : hidden ? '恢復' : '排除'}
			aria-label={summary ? '解除合併' : hidden ? '恢復' : '排除'}
			onclick={summary ? onUngroup : onToggle}
		>
			{#if summary}<Ungroup class="size-4" />{:else if hidden}<Eye
					class="size-4"
				/>{:else}<EyeOff class="size-4" />{/if}
		</Button>{/if}
	<div
		class="flex min-w-0 flex-1 items-center gap-2 rounded-xl border p-2 transition-all"
		class:border-red-500={!hidden && !isComplete(draft)}
		class:opacity-40={hidden}
		class:bg-slate-50={grouped || summary}
		class:ring-2={selected}
		role="button"
		tabindex={selecting && !hidden ? 0 : -1}
		onclick={(event) => {
			if (
				selecting &&
				!hidden &&
				!(event.target as HTMLElement).closest('[data-slot="checkbox"]')
			) {
				onSelect?.();
			}
		}}
		onkeydown={(event) => {
			if (
				event.target === event.currentTarget &&
				selecting &&
				!hidden &&
				['Enter', ' '].includes(event.key)
			) {
				event.preventDefault();
				onSelect?.();
			}
		}}
		style={color
			? `${summary ? 'border-right' : 'border-left'}: 4px solid ${color}; ${summary ? `background-color: ${color}15` : ''}`
			: ''}
	>
		{#if selecting}<Checkbox
				aria-label={`選取第 ${index} 筆`}
				checked={selected}
				disabled={hidden}
				onCheckedChange={() => onSelect?.()}
			/>{/if}
		<div class="min-w-0 flex-1 text-left">
			<span class="block text-[10px] text-muted-foreground">{date ?? '日期未定'}</span>
			<span class="flex items-center gap-2"
				><span class="truncate text-sm font-medium">{draft.note.value ?? '未命名帳目'}</span
				><span class="rounded-full bg-slate-200 px-1.5 py-0.5 text-[9px] font-bold"
					>{draft.scope.value === 'personal'
						? 'P'
						: draft.scope.value === 'household'
							? 'H'
							: '-'}</span
				></span
			>
			<span class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
				<span
					class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5"
					class:border-dashed={draft.categoryId.value === null}
				>
					{#if draft.categoryId.value !== null && ['image', 'text'].includes(draft.categoryId.source)}<Sparkles
							class="size-3"
						/>{/if}
					{$expenseOptions.find((option) => option.value === draft.categoryId.value)
						?.label ?? (draft.categoryId.value === null ? '分類未選' : '分類已不存在')}
				</span>
				{#if isComplete(draft)}<span class="text-green-700">✓ 完整</span>{/if}
				{#if draft.issues.some((issue) => issue.code === 'non_twd')}<span
						class="text-destructive">非 TWD</span
					>{/if}
				{#if grouped || summary || (draft.mergedFrom?.length ?? 0) >= 2}<span>已合併</span
					>{/if}
				{#if edited || draft.updated}<span>剛更新</span>{/if}
			</span>
		</div>
		<span class="shrink-0 text-sm font-semibold tabular-nums">{draftAmount(draft)}</span>
		{#if !selecting}<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7 shrink-0"
				aria-label={summary ? '編輯合併摘要' : `編輯第 ${index} 筆`}
				onclick={onEdit}><Pencil class="size-4" /></Button
			>{/if}
	</div>
</div>
