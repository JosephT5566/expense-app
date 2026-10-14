<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Button } from '$lib/components/shadcn/button';
	import Send from 'lucide-svelte/icons/send';
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
	let { busy = $bindable(false), onClose }: { busy?: boolean; onClose: () => void } = $props();
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
	const processing = $derived(phase === 'processing' || phase === 'persisting');
	$effect(() => {
		busy = processing;
	});
	let issues = $state<Issue[]>([]);
	let message = $state('');
	let analysis = $state('');
	let conversation = $state<{ role: 'user' | 'assistant'; text: string; analysis?: string }[]>(
		[]
	);
	let conversationElement = $state<HTMLDivElement>();
	let followLatest = true;
	$effect(() => {
		// Follow streamed updates unless the reader has scrolled back through the conversation.
		const content = [conversation.length, analysis, phase, question, message, savedExpense];
		untrack(() => {
			if (followLatest && content) {
				void tick().then(() => {
					if (followLatest && conversationElement) {
						conversationElement.scrollTop = conversationElement.scrollHeight;
					}
				});
			}
		});
	});
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
	const composingReply = $derived(phase === 'needs_input');
	const canCompose = $derived(phase === 'input' || composingReply);
	const composerCount = $derived(composingReply ? replyCount : count);
	const composerHint = $derived(
		composerCount > 500 && canCompose
			? '訊息最多 500 字，請縮短後再送出。'
			: {
					input: '資訊完整後會直接記帳。',
					needs_input: '補充這筆支出的資訊，接續剛才的對話。',
					processing: '正在解析，請等待助手回覆。',
					persisting: '正在儲存這筆支出，請稍候。',
					created: '已完成記帳，點選「新增另一筆」開始新對話。',
					rejected: '請修改內容後重新送出。',
					error: '請查看助手訊息，再修改內容或稍後重試。',
					uncertain: '請先查詢結果或重試同一請求，避免重複記帳。'
				}[phase]
	);
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
				analysis = '';
				conversation = [];
				if (next) {
					restorePending(next);
				}
			}
		});
	});
	onDestroy(() => {
		analysis = '';
		conversation = [];
		destroyed = true;
		revision++;
		controller?.abort();
	});
	export function requestClose() {
		changeOpen(false);
	}
	function changeOpen(next: boolean) {
		if (!next && processing) {
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
		onClose();
	}
	function newOperation(clear = true) {
		analysis = '';
		conversation = [];
		followLatest = true;
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
	function leavePage() {
		analysis = '';
		conversation = [];
		revision++;
		controller?.abort();
		if (processing) {
			phase = 'uncertain';
			message = '結果待確認，請查詢結果。';
		}
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
		if (processing || !$user || (phase === 'uncertain' && !query && !attempt)) {
			return;
		}
		const hadUncertainty = phase === 'uncertain';
		const owner = $user.id;
		const outgoingText = query
			? '查詢結果'
			: hadUncertainty
				? '重試同一請求'
				: phase === 'needs_input'
					? reply.trim()
					: text.trim();
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
		if (phase === 'needs_input' || phase === 'uncertain') {
			conversation.push({
				role: 'assistant',
				text: phase === 'needs_input' ? question : message || '先前請求結果待確認。',
				analysis: query ? undefined : analysis
			});
		}
		conversation.push({ role: 'user', text: outgoingText });
		followLatest = true;
		const version = ++revision;
		controller = new AbortController();
		phase = 'processing';
		analysis = '';
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
				const result = await submitSemanticEntry(
					request,
					controller.signal,
					() => {
						if (stillCurrent(version, owner)) {
							phase = 'persisting';
						}
					},
					(delta) => {
						if (stillCurrent(version, owner)) {
							analysis += delta.text;
						}
					}
				);
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

<svelte:window onpagehide={leavePage} />

<div class="flex h-[60vh] min-h-0 flex-col gap-3">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable conversation needs keyboard access.) -->
	<div
		bind:this={conversationElement}
		role="region"
		aria-label="本次對話"
		tabindex="0"
		class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain rounded-xl bg-muted/15 p-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
		onscroll={() => {
			if (conversationElement) {
				followLatest =
					conversationElement.scrollHeight -
						conversationElement.scrollTop -
						conversationElement.clientHeight <
					48;
			}
		}}
	>
		{#each conversation as entry, index (index)}
			<div class={entry.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
				<div
					class={entry.role === 'user'
						? 'max-w-[85%] rounded-2xl rounded-tr-sm bg-primary/15 px-3 py-2'
						: 'max-w-[90%] space-y-2 rounded-2xl rounded-tl-sm border bg-card px-3 py-2'}
				>
					<p class="text-muted-foreground mb-1 text-xs">
						{entry.role === 'user' ? '你' : '記帳助手'}
					</p>
					{#if entry.analysis}
						<p class="text-muted-foreground text-xs">Gemini 分析</p>
						<p aria-label="先前的分析摘要" class="whitespace-pre-wrap break-words">
							{entry.analysis}
						</p>
					{/if}
					<p
						aria-label={entry.role === 'user' ? '你的訊息' : '助手訊息'}
						class="whitespace-pre-wrap break-words"
					>
						{entry.text}
					</p>
				</div>
			</div>
		{/each}
		<div class="flex justify-start">
			<div class="max-w-[90%] space-y-2 rounded-2xl rounded-tl-sm border bg-card px-3 py-2">
				<p class="text-muted-foreground text-xs">記帳助手</p>
				{#if phase === 'input'}
					<p>今天記了什麼？告訴我一筆支出，我會幫你記帳。</p>
				{/if}
				{#if analysis}
					<div class="space-y-1">
						<p class="text-muted-foreground text-xs">Gemini 分析</p>
						<p aria-label="Gemini 分析摘要" class="whitespace-pre-wrap break-words">
							{analysis}
						</p>
					</div>
				{/if}
				{#if phase === 'needs_input'}
					<p role="status" class="font-medium">{question}</p>
				{/if}
				<div aria-live="polite" class="space-y-2">
					{#if phase === 'processing'}<p role="status">
							{analysis ? 'Gemini 分析中…' : '處理中…'}
						</p>
					{:else if phase === 'persisting'}<p role="status">正在記帳，請稍候…</p>
					{:else if phase === 'created'}<p class="font-semibold">已新增</p>
					{:else if phase === 'rejected' || phase === 'error'}<p class="font-semibold">
							未新增
						</p>
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
					{#if phase === 'uncertain'}
						<Button size="sm" onclick={() => execute(true)}>查詢結果</Button>
						{#if attempt}
							<Button size="sm" variant="outline" onclick={() => execute()}
								>重試同一請求</Button
							>
						{/if}
					{:else if phase === 'created'}
						<Button size="sm" onclick={() => newOperation()}>新增另一筆</Button>
					{:else if phase === 'rejected' || phase === 'error'}
						<Button size="sm" onclick={() => newOperation(false)}>修改後重新送出</Button
						>
					{/if}
				</div>
			</div>
		</div>
	</div>

	<div class="shrink-0 space-y-2">
		<div class="text-muted-foreground flex items-start justify-between gap-3 px-1 text-xs">
			<p id="semantic-entry-hint">{composerHint}</p>
			{#if canCompose}<span class="shrink-0 tabular-nums">{composerCount}/500</span>{/if}
		</div>
		<div
			class="bg-background flex items-end gap-2 rounded-2xl border p-2 focus-within:ring-2 focus-within:ring-ring"
		>
			<textarea
				id="semantic-entry-text"
				aria-label={composingReply ? '補充資訊' : '記帳內容'}
				aria-describedby="semantic-entry-hint"
				bind:value={
					() => (composingReply ? reply : text),
					(value) => {
						if (composingReply) {
							reply = value;
						} else {
							text = value;
						}
					}
				}
				disabled={!canCompose || (phase === 'input' && attempt !== null)}
				rows="2"
				class="min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm focus-visible:outline-none"
				placeholder={composingReply ? '輸入你的回答…' : '例如：今天午餐100元'}
			></textarea>
			<Button
				size="icon"
				class="shrink-0 rounded-xl"
				aria-label={composingReply ? '送出補充' : '送出記帳'}
				title={composingReply ? '送出補充' : '送出記帳'}
				disabled={!$user || !canCompose || composerCount === 0 || composerCount > 500}
				onclick={() => execute()}
			>
				<Send class="h-4 w-4" aria-hidden="true" />
			</Button>
		</div>
	</div>
</div>
