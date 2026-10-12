<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import { Button } from '$lib/components/shadcn/button';
	import { user } from '$lib/stores/session.store';
	import * as expensesStore from '$lib/stores/expenses.store';
	import { forceRefetchMonthlyExpenses } from '$lib/data/expenses.fetcher';
	import { getTaiwanMonthKey } from '$lib/utils/dates';
	import {
		submitSemanticEntry,
		getSemanticEntryStatus,
		SemanticEntryError
	} from '$lib/data/semantic-entry.fetcher';
	import {
		parseRequest,
		type CompletedResult,
		type Issue,
		type SemanticRequest,
		type ClarificationTurn
	} from '@jopie/semantic-entry-contract';
	let { open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void } = $props();
	let text = $state('');
	let phase = $state<
		| 'input'
		| 'needs_input'
		| 'processing'
		| 'persisting'
		| 'created'
		| 'rejected'
		| 'uncertain'
		| 'error'
	>('input');
	let attempt = $state<(SemanticRequest & { accountId: string }) | null>(null);
	let history = $state<ClarificationTurn[]>([]);
	let question = $state('');
	let reply = $state('');
	let pendingId = $state<string | null>(null);
	let savedExpense = $state<CompletedResult['expense'] | null>(null);
	const busy = $derived(phase === 'processing' || phase === 'persisting');
	let issues = $state<Issue[]>([]);
	let message = $state('');
	let revision = 0;
	let controller: AbortController | undefined;
	let accountId: string | undefined;
	let destroyed = false;
	const pendingKey = (owner: string) => `jopie:semantic-pending:${owner}`;
	function clearPending(owner: string) {
		try {
			localStorage.removeItem(pendingKey(owner));
		} catch {
			/* A stale key remains recoverable by lookup. */
		}
	}
	function restorePending(owner: string) {
		try {
			const saved = localStorage.getItem(pendingKey(owner));
			if (!saved) {
				return;
			}
			const raw = JSON.parse(saved);
			// Read legacy UUIDs without restoring their text/history, then minimize storage.
			const id = parseRequest({ requestId: raw.requestId, text: 'status' }).requestId;
			localStorage.setItem(pendingKey(owner), JSON.stringify({ requestId: id }));
			pendingId = id;
			phase = 'uncertain';
		} catch {
			phase = 'error';
			message = '無法讀取先前請求，請先檢查此網站的儲存設定。';
		}
	}
	const count = $derived([...text.trim()].length);
	const replyCount = $derived([...reply.trim()].length);
	const fields: Record<string, string> = {
		amount: '金額',
		note: '描述',
		date: '日期',
		payerId: '付款人',
		members: '成員',
		splitMemberIds: '分攤',
		currency: '幣別',
		categoryId: '分類',
		intent: '需求',
		extraction: '內容'
	};
	const codes: Record<string, string> = {
		missing: '缺少必要資訊',
		invalid: '資訊無效',
		unknown_member: '找不到指定成員',
		ambiguous_member: '無法確定成員',
		unsupported: '暫不支援',
		configuration: '服務設定不完整'
	};
	$effect(() => {
		const next = $user?.id;
		untrack(() => {
			if (next !== accountId) {
				accountId = next;
				revision++;
				controller?.abort();
				attempt = null;
				pendingId = null;
				history = [];
				question = '';
				reply = '';
				savedExpense = null;
				text = '';
				phase = 'input';
				issues = [];
				message = '';
				if (next) {
					restorePending(next);
				}
			}
		});
	});
	onDestroy(() => {
		destroyed = true;
		revision++;
		controller?.abort();
	});
	function changeOpen(next: boolean) {
		if (!next && busy) {
			message = '正在處理這筆記帳，請等待結果。';
			return;
		}
		if (!next) {
			const uncertain = phase === 'uncertain';
			newOperation();
			if (uncertain) {
				phase = 'uncertain';
			}
		}
		onOpenChange(next);
	}
	function newOperation(clear = true) {
		revision++;
		controller?.abort();
		attempt = null;
		history = [];
		question = '';
		reply = '';
		savedExpense = null;
		if (clear) {
			text = '';
		}
		phase = 'input';
		issues = [];
		message = '';
	}
	function stillCurrent(version: number, owner: string) {
		return !destroyed && version === revision && get(user)?.id === owner;
	}
	async function accept(result: CompletedResult, version: number, owner: string) {
		if (!stillCurrent(version, owner)) {
			return;
		}
		if (result.replayed) {
			const existing = get(expensesStore.items).find((row) => row.id === result.expense.id);
			const months = new Set([
				getTaiwanMonthKey(result.expense.ts),
				...(existing ? [getTaiwanMonthKey(existing.ts)] : [])
			]);
			for (const month of months) {
				const refreshed = await forceRefetchMonthlyExpenses(month, undefined, () =>
					stillCurrent(version, owner)
				);
				if (!refreshed && stillCurrent(version, owner)) {
					clearPending(owner);
					pendingId = null;
					savedExpense = result.expense;
					phase = 'created';
					message = '先前請求已完成，但清單更新失敗，請重新整理。';
					return;
				}
				if (!stillCurrent(version, owner)) {
					return;
				}
			}
		} else {
			expensesStore.upsertOne(result.expense);
		}
		if (stillCurrent(version, owner)) {
			clearPending(owner);
			pendingId = null;
			savedExpense = result.expense;
			phase = 'created';
			message = result.replayed ? '這是先前請求的完成結果，清單已重新整理。' : '';
		}
	}
	async function execute(query = false) {
		if (busy || !$user || (phase === 'uncertain' && !query && !attempt)) {
			return;
		}
		const hadUncertainty = phase === 'uncertain';
		const owner = $user.id;
		if (!query && !hadUncertainty) {
			try {
				const nextHistory =
					phase === 'needs_input' ? [...history, { question, answer: reply }] : history;
				const request = parseRequest({
					requestId: attempt?.requestId ?? crypto.randomUUID(),
					text,
					...(nextHistory.length ? { history: nextHistory } : {})
				});
				localStorage.setItem(
					pendingKey(owner),
					JSON.stringify({ requestId: request.requestId })
				);
				attempt = { ...request, accountId: owner };
				pendingId = request.requestId;
				history = request.history ?? [];
				reply = '';
			} catch {
				message = '目前無法保留請求，請允許此網站儲存資料後再試。';
				return;
			}
		}
		const operation = attempt;
		const id = operation?.requestId ?? pendingId;
		if (!id) {
			return;
		}
		const version = ++revision;
		controller = new AbortController();
		phase = 'processing';
		message = '';
		issues = [];
		try {
			if (query) {
				const completed = await getSemanticEntryStatus(id, controller.signal);
				if (!stillCurrent(version, owner)) {
					return;
				}
				if (completed) {
					await accept(completed, version, owner);
				} else {
					phase = 'uncertain';
					message = '尚未查到完成結果，仍待確認。';
				}
			} else if (operation) {
				const request = parseRequest({
					requestId: operation.requestId,
					text: operation.text,
					...(operation.history ? { history: operation.history } : {})
				});
				const result = await submitSemanticEntry(request, controller.signal, () => {
					if (stillCurrent(version, owner)) {
						phase = 'persisting';
					}
				});
				if (!stillCurrent(version, owner)) {
					return;
				}
				if (result.status === 'created') {
					await accept(result, version, owner);
				} else if (hadUncertainty) {
					phase = 'uncertain';
					message = '本次解析未完成寫入，但先前請求結果仍待確認。';
				} else {
					clearPending(owner);
					pendingId = null;
					if (result.status === 'needs_input') {
						question = result.question;
						phase = 'needs_input';
					} else {
						issues = result.issues;
						phase = 'rejected';
					}
				}
			}
		} catch (error) {
			if (!stillCurrent(version, owner)) {
				return;
			}
			const uncertain =
				hadUncertainty ||
				query ||
				!(error instanceof SemanticEntryError) ||
				error.uncertain;
			if (!uncertain) {
				clearPending(owner);
				pendingId = null;
			}
			phase = uncertain ? 'uncertain' : 'error';
			message =
				error instanceof SemanticEntryError && error.code === 'configuration'
					? '文字記帳服務尚未設定。'
					: error instanceof SemanticEntryError && error.code === 'unauthorized'
						? '請重新登入。'
						: error instanceof SemanticEntryError && error.code === 'quota_exceeded'
							? '今天的解析次數已用完。'
							: uncertain
								? '連線中斷或逾時，請查詢結果或重試同一請求。'
								: '解析服務無法完成，請稍後再試。';
		}
	}
</script>

<Dialog.Root {open} onOpenChange={changeOpen}>
	<Dialog.Content
		showCloseButton={!busy}
		onEscapeKeydown={(event) => {
			if (busy) {
				event.preventDefault();
			}
		}}
		onInteractOutside={(event) => {
			if (busy) {
				event.preventDefault();
			}
		}}
	>
		<Dialog.Header
			><Dialog.Title>文字記帳</Dialog.Title><Dialog.Description
				>描述一筆支出；資訊不足時會追問，完整後直接記帳。</Dialog.Description
			></Dialog.Header
		>
		<label for="semantic-entry-text" class="text-sm font-medium">記帳內容</label>
		<textarea
			id="semantic-entry-text"
			bind:value={text}
			disabled={attempt !== null || phase === 'uncertain'}
			rows="3"
			class="w-full rounded-md border p-3 text-sm"
			placeholder="例如：今天午餐100元"
		></textarea>
		<p class="text-muted-foreground text-xs">{count}/500 字 · 單筆台幣支出</p>
		{#if history.length}
			<div class="max-h-40 space-y-2 overflow-y-auto text-sm" aria-label="本次對話">
				{#each history as turn, index (index)}
					<p class="text-muted-foreground">{turn.question}</p>
					<p>你：{turn.answer}</p>
				{/each}
			</div>
		{/if}
		{#if phase === 'needs_input'}
			<p role="status" class="font-medium">{question}</p>
			<label for="semantic-entry-reply" class="text-sm font-medium">補充資訊</label>
			<textarea
				id="semantic-entry-reply"
				bind:value={reply}
				rows="2"
				class="w-full rounded-md border p-3 text-sm"
			></textarea>
			<p class="text-muted-foreground text-xs">{replyCount}/500 字</p>
		{/if}
		<div aria-live="polite" class="space-y-2">
			{#if phase === 'processing'}<p role="status">處理中…</p>
			{:else if phase === 'persisting'}<p role="status">正在記帳，請稍候…</p>
			{:else if phase === 'created'}<p class="font-semibold">已新增</p>
			{:else if phase === 'rejected' || phase === 'error'}<p class="font-semibold">未新增</p>
			{:else if phase === 'uncertain'}<p class="font-semibold">結果待確認</p>{/if}
			{#each issues as issue, index (index)}<p>
					{fields[issue.field] ?? '內容'}：{codes[issue.code] ?? '資訊無效'}
				</p>{/each}
			{#if savedExpense && phase === 'created'}
				<p class="text-sm">{savedExpense.note} · NT$ {savedExpense.amount}</p>
				<p class="text-sm">
					{new Date(savedExpense.ts).toLocaleDateString('zh-TW', {
						timeZone: 'Asia/Taipei'
					})}
				</p>
				{#each Object.entries(savedExpense.shares_json) as [email, amount] (email)}
					<p class="text-sm">{email}：NT$ {amount}</p>
				{/each}
			{/if}
			{#if message}<p class="text-sm">{message}</p>{/if}
		</div>
		<div class="flex flex-wrap gap-2">
			{#if phase === 'input'}<Button
					disabled={!$user || count === 0 || count > 500}
					onclick={() => execute()}>送出記帳</Button
				>
			{:else if phase === 'needs_input'}<Button
					disabled={replyCount === 0 || replyCount > 500}
					onclick={() => execute()}>送出補充</Button
				>
			{:else if phase === 'uncertain'}<Button onclick={() => execute(true)}>查詢結果</Button>
				{#if attempt}<Button variant="outline" onclick={() => execute()}
						>重試同一請求</Button
					>{/if}
			{:else if phase === 'created'}<Button onclick={() => newOperation()}>新增另一筆</Button>
			{:else if phase === 'rejected' || phase === 'error'}<Button
					onclick={() => newOperation(false)}>修改後重新送出</Button
				>{/if}
		</div>
		<p class="text-muted-foreground text-xs">關閉視窗不會取消已接受的記帳。</p>
		<p class="text-muted-foreground text-xs">
			對話關閉後捨棄；結果不明時僅保留請求編號供查詢。
		</p>
	</Dialog.Content>
</Dialog.Root>
