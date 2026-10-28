<script lang="ts">
	import type { Draft } from '@jopie/semantic-entry-contract';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import { Button } from '$lib/components/shadcn/button';
	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';
	import DraftCard from './DraftCard.svelte';
	import {
		effectiveDrafts,
		draftIssues,
		isComplete,
		type DraftSession,
		type DraftContext
	} from './drafts';
	let {
		session,
		context,
		onChange,
		onClose
	}: {
		session: DraftSession;
		context: DraftContext;
		onChange: (session: DraftSession) => void;
		onClose: (changed: boolean) => void;
	} = $props();
	let open = $state(true);
	let changed = false;
	let selecting = $state(false);
	let selected = $state<string[]>([]);
	let editing = $state<{
		draft: Draft;
		itemId: string;
		groupId?: number;
		hidden: boolean;
	} | null>(null);
	const effective = $derived(effectiveDrafts(session, context));
	const position = $derived(
		editing
			? effective.findIndex(
					(draft) =>
						draft.draftId === editing?.draft.draftId ||
						draft.mergedFrom?.includes(editing?.itemId ?? '')
				) + 1
			: 0
	);
	function update(next: DraftSession) {
		changed = true;
		onChange(next);
	}
	function select(id: string) {
		selected = selected.includes(id)
			? selected.filter((other) => other !== id)
			: [...selected, id];
	}
	function cancel() {
		selecting = false;
		selected = [];
	}
	function merge() {
		if (selected.length < 2) {
			return;
		}
		let groupId = Date.now();
		while (session.items.some((item) => item.groupId === groupId)) {
			groupId++;
		}
		const groupSummaries = { ...session.groupSummaries };
		for (const item of session.items) {
			if (selected.includes(item.id) && item.groupId !== undefined) {
				delete groupSummaries[item.groupId];
			}
		}
		update({
			items: session.items.map((item) =>
				selected.includes(item.id) && !item.hidden ? { ...item, groupId } : item
			),
			groupSummaries
		});
		cancel();
	}
	function ungroup(groupId: number) {
		const groupSummaries = { ...session.groupSummaries };
		delete groupSummaries[groupId];
		update({
			items: session.items.map((item) =>
				item.groupId === groupId ? { ...item, groupId: undefined } : item
			),
			groupSummaries
		});
	}
	function toggle(id: string) {
		const groupSummaries = { ...session.groupSummaries };
		const item = session.items.find((item) => item.id === id)!;
		if (item.groupId !== undefined) {
			delete groupSummaries[item.groupId];
		}
		update({
			items: session.items.map((item) =>
				item.id === id ? { ...item, hidden: !item.hidden } : item
			),
			groupSummaries
		});
	}
	function apply(draft: Draft) {
		if (!editing) {
			return;
		}
		const issues = draftIssues(draft, context);
		const updated: Draft = {
			...draft,
			draftId: editing.draft.draftId,
			issues,
			status: issues.length ? 'incomplete' : 'complete'
		};
		if (editing.draft.mergedFrom) {
			updated.mergedFrom = editing.draft.mergedFrom;
		} else {
			delete updated.mergedFrom;
		}
		const groupId = editing.groupId;
		const groupSummaries = { ...session.groupSummaries };
		if (groupId !== undefined) {
			groupSummaries[groupId] = updated;
		} else {
			const item = session.items.find((item) => item.id === editing?.itemId)!;
			if (item.groupId !== undefined) {
				delete groupSummaries[item.groupId];
			}
		}
		update({
			groupSummaries,
			items: session.items.map((item) =>
				groupId !== undefined
					? item.groupId === groupId
						? { ...item, edited: true }
						: item
					: item.id === editing?.itemId
						? { ...item, draft: updated, edited: true }
						: item
			)
		});
		editing = null;
	}
	function color(groupId: number) {
		const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
		return colors[
			String(groupId)
				.split('')
				.reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length
		];
	}
	function cardDraft(id: string, draft: Draft, edited: boolean) {
		return (
			effective.find((entry) => entry.draftId === id && !entry.mergedFrom) ??
			(edited ? { ...draft, issues: draftIssues(draft, context) } : draft)
		);
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		if (!next) {
			onClose(changed);
		}
	}}
>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-[425px]">
		<Dialog.Header><Dialog.Title>編輯草稿</Dialog.Title></Dialog.Header>
		<div
			class="sticky top-0 z-20 flex items-center justify-between bg-popover/95 py-1 backdrop-blur-sm"
		>
			<p class="text-sm font-medium text-muted-foreground">整理項目並送出：</p>
			{#if selecting}<div class="flex gap-2">
					<Button variant="outline" size="sm" onclick={cancel}>取消</Button><Button
						size="sm"
						disabled={selected.length < 2}
						onclick={merge}>合併所選 ({selected.length})</Button
					>
				</div>{:else}<Button variant="outline" size="sm" onclick={() => (selecting = true)}
					>合併</Button
				>{/if}
		</div>
		<div class="space-y-2 py-2" role="list" aria-label="編輯草稿項目">
			{#each session.items as item, index (item.id)}
				{@const members =
					item.groupId === undefined
						? []
						: session.items.filter((other) => other.groupId === item.groupId)}
				{@const summary =
					members.length > 1
						? effective.find((draft) =>
								draft.mergedFrom?.some((id) =>
									members.some((member) => member.id === id)
								)
							)
						: undefined}
				<div role="listitem">
					<DraftCard
						draft={cardDraft(item.id, item.draft, item.edited)}
						index={index + 1}
						hidden={item.hidden}
						edited={item.edited}
						grouped={members.length > 1}
						color={members.length > 1 ? color(item.groupId!) : undefined}
						{selecting}
						selected={selected.includes(item.id)}
						onSelect={() => select(item.id)}
						onToggle={() => toggle(item.id)}
						onEdit={() =>
							(editing = { draft: item.draft, itemId: item.id, hidden: item.hidden })}
					/>
				</div>
				{#if summary && members.at(-1)?.id === item.id && !selecting}
					<DraftCard
						draft={summary}
						index={index + 1}
						summary
						color={color(item.groupId!)}
						edited={members.some((member) => member.edited)}
						onUngroup={() => ungroup(item.groupId!)}
						onEdit={() =>
							(editing = {
								draft: summary,
								itemId: item.id,
								groupId: item.groupId,
								hidden: false
							})}
					/>
				{/if}
			{/each}
		</div>
		<div class="sticky bottom-0 space-y-2 bg-popover/95 py-2 backdrop-blur-sm">
			{#if effective.some((draft) => !isComplete(draft))}<p class="text-sm text-destructive">
					請先補齊所有預覽項目的必要欄位。
				</p>{/if}
			<Button
				class="w-full"
				disabled={selecting}
				onclick={() => {
					open = false;
					onClose(changed);
				}}
				>完成，回到對話{effective.length !== session.items.length
					? `（${effective.length} 筆）`
					: ''}</Button
			>
		</div>
		<Dialog.Root
			open={editing !== null}
			onOpenChange={(next) => {
				if (!next) {
					editing = null;
				}
			}}
		>
			<Dialog.Content class="max-h-[75vh] overflow-y-auto sm:max-w-[425px]">
				<Dialog.Header
					><Dialog.Title
						>編輯草稿{editing && !editing.hidden
							? ` ${position}/${effective.length}`
							: ''}</Dialog.Title
					></Dialog.Header
				>
				{#if editing}{#key editing.draft.draftId}<ExpenseDrawerContent
							aiDraft={editing.draft}
							onApplyDraft={apply}
						/>{/key}{/if}
			</Dialog.Content>
		</Dialog.Root>
	</Dialog.Content>
</Dialog.Root>
