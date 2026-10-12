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
		type SemanticRequest
	} from '@jopie/semantic-entry-contract';
	let { open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void } = $props();
	let text = $state('');
	let phase = $state<'input' | 'processing' | 'created' | 'rejected' | 'uncertain' | 'error'>(
		'input'
	);
	let attempt = $state<(SemanticRequest & { accountId: string }) | null>(null);
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
			const request = parseRequest(JSON.parse(saved));
			attempt = { ...request, accountId: owner };
			text = request.text;
			phase = 'uncertain';
		} catch {
			phase = 'error';
			message = '無法讀取先前請求，請先檢查此網站的儲存設定。';
		}
	}
	const count = $derived([...text.trim()].length);
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
		if (!next && phase === 'processing') {
			revision++;
			controller?.abort();
			phase = 'uncertain';
			message = '';
		}
		onOpenChange(next);
	}
	function newOperation(clear = true) {
		revision++;
		controller?.abort();
		attempt = null;
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
			phase = 'created';
			message = result.replayed ? '這是先前請求的完成結果，清單已重新整理。' : '';
		}
	}
	async function execute(query = false) {
		if (phase === 'processing' || !$user) {
			return;
		}
		const hadUncertainty = phase === 'uncertain';
		if (!attempt) {
			const request = { requestId: crypto.randomUUID(), text: text.trim() };
			try {
				localStorage.setItem(pendingKey($user.id), JSON.stringify(request));
			} catch {
				phase = 'error';
				message = '目前無法保留請求，請允許此網站儲存資料後再試。';
				return;
			}
			attempt = { ...request, accountId: $user.id };
		}
		const operation = attempt;
		const version = ++revision;
		controller = new AbortController();
		phase = 'processing';
		message = '';
		issues = [];
		try {
			if (query) {
				const completed = await getSemanticEntryStatus(
					operation.requestId,
					controller.signal
				);
				if (!stillCurrent(version, operation.accountId)) {
					return;
				}
				if (completed) {
					await accept(completed, version, operation.accountId);
				} else {
					phase = 'uncertain';
					message = '尚未查到完成結果，仍待確認。';
				}
			} else {
				const result = await submitSemanticEntry(
					{ requestId: operation.requestId, text: operation.text },
					controller.signal
				);
				if (!stillCurrent(version, operation.accountId)) {
					return;
				}
				if (result.status === 'created') {
					await accept(result, version, operation.accountId);
				} else {
					issues = result.issues;
					if (hadUncertainty) {
						phase = 'uncertain';
						message = '本次解析未通過，但先前請求結果仍待確認。';
					} else {
						clearPending(operation.accountId);
						phase = 'rejected';
					}
				}
			}
		} catch (error) {
			if (!stillCurrent(version, operation.accountId)) {
				return;
			}
			const uncertain =
				hadUncertainty ||
				query ||
				!(error instanceof SemanticEntryError) ||
				error.uncertain;
			if (!uncertain) {
				clearPending(operation.accountId);
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
	<Dialog.Content>
		<Dialog.Header
			><Dialog.Title>文字記帳</Dialog.Title><Dialog.Description
				>送出一句描述，系統會直接新增一筆支出。</Dialog.Description
			></Dialog.Header
		>
		<label for="semantic-entry-text" class="text-sm font-medium">記帳內容</label>
		<textarea
			id="semantic-entry-text"
			bind:value={text}
			disabled={attempt !== null}
			rows="3"
			class="w-full rounded-md border p-3 text-sm"
			placeholder="例如：今天午餐100元"
		></textarea>
		<p class="text-muted-foreground text-xs">{count}/500 字 · 單筆台幣支出</p>
		<div aria-live="polite" class="space-y-2">
			{#if phase === 'processing'}<p role="status">處理中…</p>
			{:else if phase === 'created'}<p class="font-semibold">已新增</p>
			{:else if phase === 'rejected' || phase === 'error'}<p class="font-semibold">未新增</p>
			{:else if phase === 'uncertain'}<p class="font-semibold">結果待確認</p>{/if}
			{#each issues as issue, index (index)}<p>
					{fields[issue.field] ?? '內容'}：{codes[issue.code] ?? '資訊無效'}
				</p>{/each}
			{#if message}<p class="text-sm">{message}</p>{/if}
		</div>
		<div class="flex flex-wrap gap-2">
			{#if phase === 'input'}<Button
					disabled={!$user || count === 0 || count > 500}
					onclick={() => execute()}>送出記帳</Button
				>
			{:else if phase === 'uncertain'}<Button onclick={() => execute(true)}>查詢結果</Button
				><Button variant="outline" onclick={() => execute()}>重試同一請求</Button>
			{:else if phase === 'created'}<Button onclick={() => newOperation()}>新增另一筆</Button>
			{:else if phase === 'rejected' || phase === 'error'}<Button
					onclick={() => newOperation(false)}>修改後重新送出</Button
				>{/if}
		</div>
		<p class="text-muted-foreground text-xs">關閉視窗不會取消已接受的記帳。</p>
		<p class="text-muted-foreground text-xs">待確認請求會暫存於此瀏覽器，完成後移除。</p>
	</Dialog.Content>
</Dialog.Root>
