<script lang="ts">
	import Clock from 'lucide-svelte/icons/clock';
	import ChevronDown from 'lucide-svelte/icons/chevron-down';
	import Eye from 'lucide-svelte/icons/eye';
	import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
	import Trash2 from 'lucide-svelte/icons/trash-2';
	import TriangleAlert from 'lucide-svelte/icons/triangle-alert';
	import TextAlignStart from 'lucide-svelte/icons/text-align-start';
	import ImageIcon from 'lucide-svelte/icons/image';
	import List from 'lucide-svelte/icons/list';
	import LoaderCircle from 'lucide-svelte/icons/loader-circle';
	import X from 'lucide-svelte/icons/x';
	import { Button } from '$lib/components/shadcn/button';
	import * as pending from './pending';
	import type { PendingItem } from './pending';

	let {
		items,
		open,
		expandedId,
		lookingUp,
		errors,
		disabled,
		canRetry,
		badge = $bindable(),
		tray = $bindable(),
		onToggle,
		onExpand,
		onQuery,
		onRetry,
		onDelete,
		onDismiss
	}: {
		items: PendingItem[];
		open: boolean;
		expandedId: string | null;
		lookingUp: { get: (id: string) => 'query' | 'delete' | 'auto' | undefined };
		errors: { get: (id: string) => string | undefined };
		disabled: boolean;
		canRetry: (id: string) => boolean;
		badge?: HTMLButtonElement;
		tray?: HTMLDivElement;
		onToggle: () => void;
		onExpand: (id: string) => void;
		onQuery: (id: string) => void;
		onRetry: (id: string) => void;
		onDelete: (id: string) => void;
		onDismiss: (id: string) => void;
	} = $props();

	const active = $derived(pending.activeCount(items));
	// Newest first (later-stored first on equal times); legacy items have no time and stay on
	// top like the approved preview.
	const ordered = $derived(
		items
			.map((item, index) => ({ item, index }))
			.sort(
				(a, b) =>
					(b.item.submittedAt ?? Number.POSITIVE_INFINITY) -
						(a.item.submittedAt ?? Number.POSITIVE_INFINITY) || b.index - a.index
			)
			.map(({ item }) => item)
	);
	const taipei = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Asia/Taipei',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	function sentAt(ts: number) {
		const part = Object.fromEntries(
			taipei.formatToParts(new Date(ts)).map((value) => [value.type, value.value])
		);
		return `${part.month}/${part.day} ${part.hour}:${part.minute} 送出`;
	}
	function title(item: PendingItem) {
		if (item.snippet) {
			// Only the first 12 characters are stored; a full-length snippet may have been cut.
			return [...item.snippet].length >= pending.SNIPPET_LENGTH
				? `${item.snippet}…`
				: item.snippet;
		}
		if (item.kind === 'analyze') {
			return '（圖片，未存文字）';
		}
		return item.kind === 'commit' ? '（草稿，未存內容）' : '';
	}
	let arrowLeft = $state(24);
	$effect(() => {
		if (open && badge) {
			arrowLeft = badge.offsetLeft + badge.offsetWidth / 2 - 6;
		}
	});
</script>

{#snippet kindTag(item: PendingItem)}
	{#if item.kind !== 'legacy'}
		<span
			class="inline-flex items-center gap-[3px] rounded-full bg-[rgba(111,164,175,0.18)] px-1.5 text-[10.5px] leading-4 font-semibold text-[#245b66]"
		>
			{#if item.kind === 'commit'}
				<List class="size-2.5" aria-hidden="true" />確認 {item.draftCount ?? 0} 筆草稿
			{:else if item.imageCount}
				<ImageIcon class="size-2.5" aria-hidden="true" />圖片 {item.imageCount} 張
			{:else}
				<TextAlignStart class="size-2.5" aria-hidden="true" />文字
			{/if}
		</span>
	{/if}
{/snippet}

{#if items.length}
	<button
		bind:this={badge}
		type="button"
		aria-label={active ? `待確認 ${active} 筆` : '待確認'}
		aria-expanded={open}
		aria-controls="semantic-pending-tray"
		aria-haspopup="dialog"
		class="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full border border-[#f5d38a] bg-[#fef3c7] px-[9px] text-xs font-semibold text-[#b45309] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 {open
			? 'shadow-[0_0_0_2px_#b45309]'
			: ''}"
		onclick={onToggle}
	>
		<Clock class="size-3" aria-hidden="true" />待確認{#if active}<span
				class="grid h-4 min-w-4 place-items-center rounded-full bg-[#b45309] px-1 text-[10px] text-white"
				>{active}</span
			>{/if}
	</button>
{/if}

{#if open && items.length}
	<div
		bind:this={tray}
		id="semantic-pending-tray"
		role="dialog"
		aria-label="待確認"
		tabindex="-1"
		class="absolute top-[calc(100%+0.5rem)] -right-8 left-0 z-30 flex max-h-[60vh] flex-col gap-1.5 rounded-xl border bg-popover p-2.5 text-left font-normal text-popover-foreground shadow-[0_12px_30px_rgba(0,0,0,0.22)] outline-none"
	>
		<span
			aria-hidden="true"
			class="absolute -top-[7px] size-3 rotate-45 border-t border-l bg-popover"
			style:left="{arrowLeft}px"
		></span>
		<div class="flex items-center justify-between text-xs font-semibold">
			<span>{active ? `待確認 ${active} 筆` : '待確認'}</span>
			<span class="text-[11px] font-normal text-muted-foreground">點一筆展開</span>
		</div>
		<ul class="-mx-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto px-1">
			{#each ordered as item (item.requestId)}
				{@const lookup = lookingUp.get(item.requestId)}
				{@const busy = !!lookup}
				{#if item.expiredAt !== null}
					<li
						class="flex items-center gap-2 rounded-[10px] border border-slate-200 bg-slate-100 px-2.5 py-2 text-slate-500"
					>
						<div class="min-w-0 flex-1">
							<p class="truncate text-[13px] font-medium">{title(item)}</p>
							{#if item.submittedAt !== null}
								<p class="mt-0.5 flex items-center gap-1.5 text-[11px]">
									{sentAt(item.submittedAt)}
									{@render kindTag(item)}
								</p>
							{/if}
						</div>
						<span class="shrink-0 text-xs font-semibold text-slate-600">已過期</span>
						<Button
							variant="ghost"
							size="icon-lg"
							class="shrink-0"
							aria-label="關閉已過期項目"
							title="關閉已過期項目"
							onclick={() => onDismiss(item.requestId)}
							><X aria-hidden="true" /></Button
						>
					</li>
				{:else}
					{@const expanded = expandedId === item.requestId}
					<li
						class="flex flex-col gap-1.5 rounded-[10px] border px-2.5 py-2 {expanded
							? 'border-[#f5d38a] bg-[#fffbeb]'
							: 'border-[#efe6d8] bg-[#fffdf9]'}"
					>
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
							aria-expanded={expanded}
							aria-controls="semantic-pending-{item.requestId}"
							onclick={() => onExpand(item.requestId)}
						>
							<span class="block min-w-0 flex-1">
								<span class="block truncate text-[13px] font-medium"
									>{title(item)}</span
								>
								<span
									class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
								>
									{item.submittedAt !== null ? sentAt(item.submittedAt) : ''}
									{@render kindTag(item)}
									<span
										class="inline-flex items-center gap-[3px] rounded-full bg-[#fef3c7] px-[7px] text-[10.5px] leading-4 font-semibold text-[#b45309]"
										><Clock class="size-2.5" aria-hidden="true" />待確認</span
									>
								</span>
							</span>
							<ChevronDown
								class="size-4 shrink-0 text-muted-foreground transition-transform {expanded
									? 'rotate-180'
									: ''}"
								aria-hidden="true"
							/>
						</button>
						{#if expanded}
							<div
								id="semantic-pending-{item.requestId}"
								class="flex flex-col gap-1.5"
							>
								<p
									class="flex items-start gap-1 text-xs text-[#b45309]"
									aria-live="polite"
								>
									<TriangleAlert
										class="mt-px size-3.5 shrink-0"
										aria-hidden="true"
									/><span
										>{errors.get(item.requestId) ?? '尚未查到完成結果。'}</span
									>
								</p>
								<div class="flex flex-wrap gap-1.5">
									<Button
										size="icon-lg"
										aria-label="查詢結果"
										title="查詢結果"
										aria-busy={lookup === 'query'}
										disabled={disabled || busy}
										onclick={() => onQuery(item.requestId)}
										>{#if lookup === 'query'}<LoaderCircle
												class="animate-spin"
												aria-hidden="true"
											/>{:else}<Eye aria-hidden="true" />{/if}</Button
									>
									{#if canRetry(item.requestId)}
										<Button
											variant="outline"
											size="icon-lg"
											aria-label="重試同一請求"
											title="重試同一請求"
											disabled={disabled || busy}
											onclick={() => onRetry(item.requestId)}
											><RotateCcw aria-hidden="true" /></Button
										>
									{/if}
									<span class="flex-1"></span>
									<Button
										variant="outline"
										size="icon-lg"
										class="text-destructive hover:text-destructive"
										aria-label="刪除這筆待確認"
										title="刪除這筆待確認"
										aria-busy={lookup === 'delete'}
										disabled={disabled || busy}
										onclick={() => onDelete(item.requestId)}
										>{#if lookup === 'delete'}<LoaderCircle
												class="animate-spin"
												aria-hidden="true"
											/>{:else}<Trash2 aria-hidden="true" />{/if}</Button
									>
								</div>
							</div>
						{/if}
					</li>
				{/if}
			{/each}
		</ul>
	</div>
{/if}
