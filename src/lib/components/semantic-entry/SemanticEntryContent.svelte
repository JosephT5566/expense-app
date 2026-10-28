<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Button } from '$lib/components/shadcn/button';
	import Paperclip from 'lucide-svelte/icons/paperclip';
	import Camera from 'lucide-svelte/icons/camera';
	import X from 'lucide-svelte/icons/x';
	import CreatedSummary from './CreatedSummary.svelte';
	import DraftBlock from './DraftBlock.svelte';
	import DraftEditDialog from './DraftEditDialog.svelte';
	import {
		fromServerDrafts,
		effectiveDrafts,
		isComplete,
		toClientDraft,
		issueText,
		type DraftSession
	} from './drafts';
	import type { DraftIssue, SemanticResponseV3 } from '@jopie/semantic-entry-contract';
	import { expenseOptions } from '$lib/stores/categories.store';
	import { allowedUsers } from '$lib/stores/appSetting.store';
	import type { ExpenseRow } from '$lib/types/expense';
	import Send from 'lucide-svelte/icons/send';
	import { user } from '$lib/stores/session.store';
	import * as expensesStore from '$lib/stores/expenses.store';
	import { forceRefetchMonthlyExpenses } from '$lib/data/expenses.fetcher';
	import { getTaiwanMonthKey, toISODateOnly } from '$lib/utils/dates';
	import {
		submitSemanticEntry,
		getSemanticEntryStatus,
		requestImageUploads,
		uploadImage,
		SemanticEntryError
	} from '$lib/data/semantic-entry.fetcher';
	import {
		parseRequestV3,
		MAX_IMAGE_BYTES,
		MAX_TOTAL_IMAGE_BYTES,
		UPLOAD_IMAGE_TYPES,
		type UploadImageType,
		type IssueV3,
		type SemanticRequestV3,
		type ClarificationTurn
	} from '@jopie/semantic-entry-contract';
	let { busy = $bindable(false), onClose }: { busy?: boolean; onClose: () => void } = $props();
	let text = $state('');
	let session = $state<DraftSession | null>(null);
	let revised = $state(false);
	let draftHeading = $state('');
	let draftAnalysis = $state('');
	let draftRejected = $state(false);
	let draftWarning = $state('');
	let serverDraftIssues = $state<Record<string, DraftIssue[]>>({});
	const draftContext = $derived({
		today: toISODateOnly(new Date(Date.now() + 8 * 60 * 60 * 1000)),
		categoryIds: new Set($expenseOptions.map((option) => option.value)),
		allowedEmails: $allowedUsers,
		currentUserEmail: $user?.email ?? ''
	});
	const drafts = $derived(
		session
			? effectiveDrafts(session, draftContext).map((draft) =>
					serverDraftIssues[draft.draftId] &&
					!draft.mergedFrom?.length &&
					!session?.items.find((item) => item.id === draft.draftId)?.edited
						? {
								...draft,
								issues: serverDraftIssues[draft.draftId],
								status: 'incomplete' as const
							}
						: draft
				)
			: []
	);
	let editingDrafts = $state(false);
	let closeGuard = false;
	function onEditDrafts() {
		if (session) {
			session = {
				...session,
				items: session.items.map((item) =>
					serverDraftIssues[item.id] && !item.edited
						? {
								...item,
								draft: {
									...item.draft,
									issues: serverDraftIssues[item.id],
									status: 'incomplete'
								}
							}
						: item
				)
			};
		}
		editingDrafts = true;
	}
	function receiveDrafts(result: Extract<SemanticResponseV3, { status: 'drafts' }>) {
		session = fromServerDrafts(result.drafts);
		serverDraftIssues = {};
		if (draftRejected) {
			draftAnalysis = '';
		}
		draftRejected = false;
		draftWarning = '';
		draftHeading = `找到 ${drafts.length} 筆，${result.reason === 'multiple' ? '因為有多筆' : '有資料需要補齊'}，還沒記帳。`;
		if (!conversation.some((entry) => entry.drafts)) {
			draftAnalysis = analysis;
			conversation.push({ role: 'assistant', text: '', drafts: true });
		}
		analysis = '';
		text = '';
		attempt = null;
		phase = 'drafts';
	}
	let phase = $state<
		| 'input'
		| 'drafts'
		| 'needs_input'
		| 'processing'
		| 'persisting'
		| 'created'
		| 'rejected'
		| 'uncertain'
		| 'error'
	>('input');
	let attempt = $state<(SemanticRequestV3 & { accountId: string }) | null>(null);
	let history = $state<ClarificationTurn[]>([]);
	let question = $state('');
	let reply = $state('');
	let pendingId = $state<string | null>(null);
	let savedExpense = $state<ExpenseRow | null>(null);
	const processing = $derived(phase === 'processing' || phase === 'persisting');
	$effect(() => {
		busy = processing || converting;
	});
	let issues = $state<IssueV3[]>([]);
	let message = $state('');
	let analysis = $state('');
	let conversation = $state<
		{
			role: 'user' | 'assistant';
			text: string;
			analysis?: string;
			images?: string[];
			expenses?: ExpenseRow[];
			drafts?: boolean;
		}[]
	>([]);
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
	let selectedImages = $state<{ file: File; url: string }[]>([]);
	let imageError = $state('');
	let converting = $state(false);
	let uploading = $state(false);
	let fileInput: HTMLInputElement;
	let cameraInput: HTMLInputElement;

	function clearImages() {
		selectedImages.forEach((image) => URL.revokeObjectURL(image.url));
		selectedImages = [];
		imageError = '';
		converting = false;
		uploading = false;
	}
	function clearConversation() {
		conversation.forEach((entry) => entry.images?.forEach((url) => URL.revokeObjectURL(url)));
		conversation = [];
		session = null;
		editingDrafts = false;
		revised = false;
		serverDraftIssues = {};
		draftHeading = '';
		draftAnalysis = '';
		draftWarning = '';
		draftRejected = false;
	}
	function removeImage(index: number) {
		URL.revokeObjectURL(selectedImages[index].url);
		selectedImages = selectedImages.filter((_, i) => i !== index);
		imageError = '';
	}
	async function selectImages(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (!files.length || attachmentsDisabled) {
			return;
		}
		if (selectedImages.length + files.length > 4) {
			imageError = '最多附加 4 張圖片。';
			return;
		}
		const version = revision;
		const owner = accountId;
		converting = true;
		const converted: File[] = [];
		try {
			for (const file of files) {
				if (
					/\.(heic|heif)$/i.test(file.name) ||
					['image/heic', 'image/heif'].includes(file.type)
				) {
					imageError = '轉換 HEIC 中…';
					try {
						const heic2any = (await import('heic2any')).default;
						const result = await heic2any({
							blob: file,
							toType: 'image/jpeg',
							quality: 0.7
						});
						converted.push(
							new File(
								[Array.isArray(result) ? result[0] : result],
								file.name.replace(/\.(heic|heif)$/i, '') + '.jpg',
								{ type: 'image/jpeg' }
							)
						);
					} catch {
						if (version === revision && owner === accountId) {
							imageError = 'HEIC/HEIF 圖片轉換失敗，請改用 JPEG、PNG 或 WebP。';
						}
						return;
					}
				} else {
					converted.push(file);
				}
				if (version !== revision || owner !== accountId || destroyed) {
					return;
				}
			}
			const all = [...selectedImages.map((image) => image.file), ...converted];
			if (all.some((file) => !UPLOAD_IMAGE_TYPES.includes(file.type as UploadImageType))) {
				imageError = '只支援 JPG、PNG、WebP、HEIC 圖片。';
			} else if (all.some((file) => file.size > MAX_IMAGE_BYTES)) {
				imageError = '單張圖片不能超過 10 MiB。';
			} else if (all.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_IMAGE_BYTES) {
				imageError = '圖片總計不能超過 20 MiB。';
			} else {
				selectedImages = [
					...selectedImages,
					...converted.map((file) => ({ file, url: URL.createObjectURL(file) }))
				];
				imageError = '';
			}
		} finally {
			if (version === revision && owner === accountId) {
				converting = false;
			}
		}
	}
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
			const id = parseRequestV3({
				action: 'analyze',
				requestId: raw.requestId,
				text: 'status'
			}).requestId;
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
	const canCompose = $derived(phase === 'input' || phase === 'drafts' || composingReply);
	const attachmentsDisabled = $derived(
		!canCompose || !!session || composingReply || converting || selectedImages.length >= 4
	);
	const composerCount = $derived(composingReply ? replyCount : count);
	const composerHint = $derived(
		composerCount > 500 && canCompose
			? '訊息最多 500 字，請縮短後再送出。'
			: {
					drafts: text.trim()
						? '補充只更新草稿，不會重新讀取圖片。'
						: drafts.length > 0 && drafts.every(isComplete)
							? '可以繼續補充，或按「全部記帳」。'
							: revised
								? '可以繼續打字補充，或按「進入編輯」。'
								: '可以直接打字補充，例如「第三筆是午餐」。',
					input: '資訊完整後會直接記帳；多筆或不完整時會先列出草稿。',
					needs_input: attempt?.referenceDate
						? `本次「今天」固定為 ${attempt.referenceDate}（台灣日期）。日期更正請填完整年月日。`
						: '補充這筆支出的資訊，接續剛才的對話。',
					processing: '正在解析，請等待助手回覆。',
					persisting: '正在儲存這筆支出，請稍候。',
					created: '已完成記帳，點選「新增另一筆」開始新對話。',
					rejected: '請修改內容後重新送出。',
					error: '請查看助手訊息，再修改內容或稍後重試。',
					uncertain: '請先查詢結果或重試同一請求，避免重複記帳。'
				}[phase]
	);
	const fields: Record<string, string> = {
		images: '圖片',
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
				if ((uploading || attempt?.action === 'revise') && accountId) {
					clearPending(accountId);
				}
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
				clearConversation();
				clearImages();
				if (next) {
					restorePending(next);
				}
			}
		});
	});
	onDestroy(() => {
		if ((uploading || attempt?.action === 'revise') && accountId) {
			clearPending(accountId);
		}
		analysis = '';
		clearConversation();
		clearImages();
		destroyed = true;
		revision++;
		controller?.abort();
	});
	export function requestClose() {
		if (editingDrafts || closeGuard) {
			return;
		}
		changeOpen(false);
	}
	function changeOpen(next: boolean) {
		if (!next && (processing || converting)) {
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
		clearConversation();
		clearImages();
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
		const interruptedUpload = uploading;
		const interruptedRevision = attempt?.action === 'revise';
		analysis = '';
		clearConversation();
		clearImages();
		revision++;
		controller?.abort();
		if (interruptedUpload) {
			if (accountId) {
				clearPending(accountId);
			}
			pendingId = null;
			attempt = null;
			phase = 'error';
			message = '圖片上傳失敗，請稍後再試。';
		} else if (interruptedRevision) {
			if (accountId) {
				clearPending(accountId);
			}
			pendingId = null;
			attempt = null;
			phase = 'input';
		} else if (processing) {
			phase = 'uncertain';
			message = '結果待確認，請查詢結果。';
		}
	}
	async function accept(
		result: { expenses: ExpenseRow[]; replayed: boolean },
		version: number,
		owner: string
	) {
		if (!stillCurrent(version, owner)) {
			return;
		}
		let refreshFailed = false;
		if (result.replayed) {
			const existing = get(expensesStore.items).filter((row) =>
				result.expenses.some((saved) => saved.id === row.id)
			);
			const months = new Set(
				[...result.expenses, ...existing].map((row) => getTaiwanMonthKey(row.ts))
			);
			for (const month of months) {
				const refreshed = await forceRefetchMonthlyExpenses(month, undefined, () =>
					stillCurrent(version, owner)
				);
				if (!stillCurrent(version, owner)) {
					return;
				}
				if (!refreshed) {
					refreshFailed = true;
				}
			}
		} else {
			result.expenses.forEach((row) => expensesStore.upsertOne(row));
		}
		if (!stillCurrent(version, owner)) {
			return;
		}
		clearPending(owner);
		pendingId = null;
		message = refreshFailed
			? '先前請求已完成，但清單更新失敗，請重新整理。'
			: result.replayed
				? '這是先前請求的完成結果，清單已重新整理。'
				: '';
		if (attempt?.images || attempt?.action === 'commit' || result.expenses.length > 1) {
			conversation = conversation.filter((entry) => !entry.drafts);
			session = null;
			editingDrafts = false;
			revised = false;
			serverDraftIssues = {};
			draftWarning = '';
			conversation.push({
				role: 'assistant',
				text: message,
				analysis,
				expenses: result.expenses
			});
			clearImages();
			attempt = null;
			history = [];
			question = '';
			reply = '';
			text = '';
			analysis = '';
			message = '';
			phase = 'input';
		} else {
			savedExpense = result.expenses[0];
			phase = 'created';
		}
	}
	const generalIssueText = (issue: IssueV3) =>
		`${fields[issue.field] ?? '內容'}：${codes[issue.code] ?? '資訊無效'}`;
	function draftError(error: unknown) {
		if (error instanceof SemanticEntryError) {
			if (error.code === 'unauthorized') {
				return '請重新登入';
			}
			if (error.code === 'quota_exceeded') {
				return '今天的解析次數已用完';
			}
			if (error.code === 'connection') {
				return '連線中斷或逾時';
			}
			if (error.code === 'persist_uncertain') {
				return '伺服器無法確認寫入結果';
			}
		}
		return '解析服務無法完成';
	}
	async function executeDraft(action: 'revise' | 'commit', retry = false) {
		if (!$user || !session || processing || converting || (phase === 'uncertain' && !retry)) {
			return;
		}
		if (!retry && action === 'commit' && (!drafts.length || !drafts.every(isComplete))) {
			return;
		}
		if (action === 'revise' && (!text.trim() || count > 500)) {
			return;
		}
		const owner = $user.id;
		let request: SemanticRequestV3;
		try {
			if (retry) {
				if (attempt?.action !== 'commit') {
					return;
				}
				request = parseRequestV3({
					action: 'commit',
					requestId: attempt.requestId,
					...(attempt.referenceDate ? { referenceDate: attempt.referenceDate } : {}),
					drafts: attempt.drafts
				});
			} else {
				request = parseRequestV3({
					action,
					requestId: crypto.randomUUID(),
					referenceDate: draftContext.today,
					drafts: drafts.map(toClientDraft),
					...(action === 'revise' ? { text } : {})
				});
			}
			localStorage.setItem(
				pendingKey(owner),
				JSON.stringify({ requestId: request.requestId })
			);
		} catch {
			conversation.push({
				role: 'assistant',
				text: '目前無法保留請求，請允許此網站儲存資料後再試。'
			});
			return;
		}
		attempt = { ...request, accountId: owner };
		pendingId = request.requestId;
		if (action === 'revise') {
			conversation.push({ role: 'user', text: text.trim() });
			text = '';
			revised = true;
		}
		const version = ++revision;
		controller = new AbortController();
		phase = 'processing';
		analysis = '';
		message = '';
		draftWarning = '';
		followLatest = true;
		try {
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
				return;
			}
			if (result.status === 'drafts') {
				const responseAnalysis = analysis;
				receiveDrafts(result);
				if (action === 'revise') {
					conversation.push({
						role: 'assistant',
						text: responseAnalysis ? '' : '已更新草稿。',
						analysis: responseAnalysis
					});
				}
			} else if (action === 'commit' && result.status === 'rejected') {
				draftRejected = true;
				draftHeading = `未記帳：${drafts.length} 筆都沒有寫入`;
				const known = new Set(drafts.map((draft) => draft.draftId));
				const matching = result.draftIssues?.filter(
					(item) => known.has(item.draftId) && item.issues.length
				);
				serverDraftIssues = Object.fromEntries(
					(matching ?? []).map((item) => [item.draftId, item.issues])
				);
				const unmatched =
					result.draftIssues
						?.filter((item) => !known.has(item.draftId))
						.flatMap((item) => item.issues.map(issueText)) ?? [];
				draftAnalysis = [
					result.draftIssues
						? `伺服器檢查時發現 ${new Set(result.draftIssues.map((item) => item.draftId)).size} 筆有問題，草稿都還在。`
						: result.issues.map(generalIssueText).join('、'),
					...unmatched
				].join('、');
				phase = 'drafts';
			} else {
				conversation.push({
					role: 'assistant',
					text: [
						...(result.status === 'needs_input' ? [result.question] : []),
						...result.issues.map(generalIssueText)
					].join('、'),
					analysis
				});
				analysis = '';
				phase = 'drafts';
			}
			analysis = '';
			clearPending(owner);
			pendingId = null;
			attempt = null;
		} catch (error) {
			if (!stillCurrent(version, owner)) {
				return;
			}
			if (
				action === 'commit' &&
				(retry || !(error instanceof SemanticEntryError) || error.uncertain)
			) {
				phase = 'uncertain';
				draftWarning =
					error instanceof SemanticEntryError && error.code === 'persist_uncertain'
						? '伺服器無法確認寫入結果。重新確認不會重複記帳。'
						: '連線逾時。重新確認不會重複記帳。';
			} else {
				conversation.push({
					role: 'assistant',
					text:
						action === 'revise'
							? `沒有更新草稿：${draftError(error)}，請再送出一次。`
							: `未記帳：${draftError(error)}`
				});
				clearPending(owner);
				pendingId = null;
				attempt = null;
				phase = 'drafts';
				analysis = '';
			}
		}
	}
	async function execute(query = false) {
		if (phase === 'drafts' && !query) {
			await executeDraft('revise');
			return;
		}
		if (processing || converting || !$user || (phase === 'uncertain' && !query && !attempt)) {
			return;
		}
		imageError = '';
		let uploadContext: { requestId: string; referenceDate: string; text?: string } | undefined;
		const filesToUpload = selectedImages.map((image) => image.file);
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
				const identity = {
					requestId: attempt?.requestId ?? crypto.randomUUID(),
					referenceDate:
						attempt?.referenceDate ??
						toISODateOnly(new Date(Date.now() + 8 * 60 * 60 * 1000))
				};
				if (count > 500) {
					return;
				}
				const request = filesToUpload.length
					? null
					: parseRequestV3({
							action: 'analyze',
							...identity,
							text,
							...(nextHistory.length ? { history: nextHistory } : {})
						});
				localStorage.setItem(
					pendingKey(owner),
					JSON.stringify({ requestId: identity.requestId })
				);
				if (request) {
					attempt = { ...request, accountId: owner };
					history = request.history ?? [];
				} else {
					uploadContext = {
						...identity,
						...(text.trim() ? { text: text.trim().normalize('NFC') } : {})
					};
				}
				pendingId = identity.requestId;
				reply = '';
			} catch {
				message = '目前無法保留請求，請允許此網站儲存資料後再試。';
				return;
			}
		}
		let operation = attempt;
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
		conversation.push({
			role: 'user',
			text: outgoingText,
			...(!query && !hadUncertainty && selectedImages.length
				? { images: selectedImages.map((image) => image.url) }
				: {})
		});
		selectedImages = [];
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
			} else if (operation || uploadContext) {
				if (uploadContext) {
					uploading = true;
					const targets = await requestImageUploads(
						filesToUpload.map((file) => ({
							contentType: file.type as UploadImageType,
							size: file.size
						})),
						controller.signal
					);
					if (!stillCurrent(version, owner)) {
						return;
					}
					for (let i = 0; i < targets.length; i++) {
						await uploadImage(targets[i], filesToUpload[i], controller.signal);
						if (!stillCurrent(version, owner)) {
							return;
						}
					}
					operation = {
						action: 'analyze',
						...uploadContext,
						images: targets.map((target) => target.path),
						accountId: owner
					};
					attempt = operation;
					uploading = false;
				}
				if (!operation) {
					throw new SemanticEntryError('invalid_request', false);
				}
				const request = parseRequestV3({
					action: operation.action,
					requestId: operation.requestId,
					...(operation.referenceDate ? { referenceDate: operation.referenceDate } : {}),
					...(operation.images ? { images: operation.images } : {}),
					...(operation.drafts ? { drafts: operation.drafts } : {}),
					...(operation.text !== undefined ? { text: operation.text } : {}),
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
						if (result.status === 'drafts') {
							receiveDrafts(result);
						} else {
							issues = result.issues;
						}
						if (result.status !== 'drafts') {
							phase = 'rejected';
						}
					}
				}
			}
		} catch (error) {
			if (!stillCurrent(version, owner)) {
				return;
			}
			const failedUpload = uploading;
			const uncertain =
				!failedUpload &&
				(hadUncertainty ||
					query ||
					!(error instanceof SemanticEntryError) ||
					error.uncertain);
			if (!uncertain) {
				clearPending(owner);
				pendingId = null;
			}
			phase = uncertain ? 'uncertain' : 'error';
			message =
				!uncertain && error instanceof SemanticEntryError && error.code.startsWith('image_')
					? failedUpload
						? '圖片上傳失敗，請稍後再試。'
						: '圖片無法使用，請重新選擇圖片。'
					: error instanceof SemanticEntryError && error.code === 'configuration'
						? '文字記帳服務尚未設定。'
						: error instanceof SemanticEntryError && error.code === 'unauthorized'
							? '請重新登入。'
							: error instanceof SemanticEntryError && error.code === 'quota_exceeded'
								? '今天的解析次數已用完。'
								: uncertain
									? '連線中斷或逾時，請查詢結果或重試同一請求。'
									: '解析服務無法完成，請稍後再試。';
		} finally {
			if (stillCurrent(version, owner)) {
				uploading = false;
			}
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
			{#if entry.drafts && session}
				<div class="space-y-2">
					<p class="text-xs text-muted-foreground">記帳助手</p>
					{#if draftAnalysis && !draftRejected}<p class="text-xs text-muted-foreground">
							Gemini 分析
						</p>
						<p class="whitespace-pre-wrap break-words">{draftAnalysis}</p>{/if}
					<p class:text-destructive={draftRejected}>{draftHeading}</p>
					{#if draftRejected}<p class="text-destructive">{draftAnalysis}</p>{/if}
					<DraftBlock
						{drafts}
						editedIds={session.items
							.filter((item) => item.edited)
							.map((item) => item.id)}
						disabled={processing || phase === 'uncertain'}
						{onEditDrafts}
						onCommit={() => executeDraft('commit')}
					/>
					{#if draftWarning}<div
							role="alert"
							class="space-y-2 rounded-xl border border-amber-500 bg-amber-500/10 p-3"
						>
							<p class="font-semibold">無法確認是否已記帳</p>
							<p>{draftWarning}</p>
							<div class="flex gap-2">
								<Button size="sm" onclick={() => executeDraft('commit', true)}
									>重新確認</Button
								><Button size="sm" variant="outline" onclick={requestClose}
									>稍後再看</Button
								>
							</div>
						</div>{/if}
				</div>
			{:else}
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
						{#if entry.images}<div class="mb-2 flex gap-2">
								{#each entry.images as url (url)}<img
										src={url}
										alt="附加圖片"
										class="h-12 w-12 rounded-lg object-cover"
									/>{/each}
							</div>{/if}
						{#if entry.expenses}<CreatedSummary expenses={entry.expenses} />{/if}
						<p
							aria-label={entry.role === 'user' ? '你的訊息' : '助手訊息'}
							class="whitespace-pre-wrap break-words"
						>
							{entry.text}
						</p>
					</div>
				</div>
			{/if}
		{/each}
		{#if !session || processing || analysis || message}
			<div class="flex justify-start">
				<div
					class="max-w-[90%] space-y-2 rounded-2xl rounded-tl-sm border bg-card px-3 py-2"
				>
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
								{uploading
									? '上傳圖片中…'
									: attempt?.action === 'commit'
										? '記帳中…'
										: analysis
											? 'Gemini 分析中…'
											: '處理中…'}
							</p>
						{:else if phase === 'persisting'}<p role="status">正在記帳，請稍候…</p>
						{:else if phase === 'created'}<p class="font-semibold">已新增</p>
						{:else if phase === 'rejected' || phase === 'error'}<p
								class="font-semibold"
							>
								未新增
							</p>
						{:else if phase === 'uncertain'}<p class="font-semibold">結果待確認</p>{/if}
						{#each issues as issue, index (index)}<p>
								{issue.field === 'images' && issue.code === 'not_a_receipt'
									? '圖片看起來不是收據，請重新選擇圖片。'
									: issue.code === 'too_many_drafts'
										? '一次最多 20 筆，請分批送出。'
										: `${fields[issue.field] ?? '內容'}：${codes[issue.code] ?? '資訊無效'}`}
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
						{#if phase === 'uncertain' && !session}
							<Button size="sm" onclick={() => execute(true)}>查詢結果</Button>
							{#if attempt}
								<Button size="sm" variant="outline" onclick={() => execute()}
									>重試同一請求</Button
								>
							{/if}
						{:else if phase === 'created'}
							<Button size="sm" onclick={() => newOperation()}>新增另一筆</Button>
						{:else if phase === 'rejected' || phase === 'error'}
							<Button size="sm" onclick={() => newOperation(false)}
								>修改後重新送出</Button
							>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>

	<div class="shrink-0 space-y-2">
		<div class="text-muted-foreground flex items-start justify-between gap-3 px-1 text-xs">
			<p id="semantic-entry-hint">{imageError || composerHint}</p>
			{#if canCompose}<span class="shrink-0 tabular-nums">{composerCount}/500</span>{/if}
		</div>
		{#if selectedImages.length}<div class="flex gap-2 px-1">
				{#each selectedImages as image, i (image.url)}<div class="relative">
						<img
							src={image.url}
							alt={`第 ${i + 1} 張附圖`}
							class="h-12 w-12 rounded-lg object-cover"
						/><Button
							size="icon"
							variant="outline"
							class="absolute -right-1 -top-1 h-5 w-5 rounded-full"
							aria-label={`移除第 ${i + 1} 張圖片`}
							disabled={processing || converting}
							onclick={() => removeImage(i)}><X class="h-3 w-3" /></Button
						>
					</div>{/each}
			</div>{/if}
		<input
			bind:this={fileInput}
			type="file"
			multiple
			accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
			class="hidden"
			onchange={selectImages}
		/>
		<input
			bind:this={cameraInput}
			type="file"
			accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
			capture="environment"
			class="hidden"
			onchange={selectImages}
		/>
		<div
			class="bg-background flex items-end gap-2 rounded-2xl border p-2 focus-within:ring-2 focus-within:ring-ring"
		>
			<Button
				size="icon"
				variant="ghost"
				class="shrink-0"
				aria-label="附加圖片"
				disabled={attachmentsDisabled}
				onclick={() => fileInput.click()}><Paperclip class="h-4 w-4" /></Button
			>
			<Button
				size="icon"
				variant="ghost"
				class="shrink-0"
				aria-label="拍照"
				disabled={attachmentsDisabled}
				onclick={() => cameraInput.click()}><Camera class="h-4 w-4" /></Button
			>
			<textarea
				id="semantic-entry-text"
				aria-label={phase === 'drafts'
					? '補充草稿'
					: composingReply
						? '補充資訊'
						: '記帳內容'}
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
				disabled={converting || !canCompose || (phase === 'input' && attempt !== null)}
				rows="2"
				class="min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm focus-visible:outline-none"
				placeholder={phase === 'drafts'
					? '例如：第三筆是午餐'
					: composingReply
						? '輸入你的回答…'
						: '例如：今天午餐100元'}
			></textarea>
			<Button
				size="icon"
				class="shrink-0 rounded-xl"
				aria-label={composingReply || phase === 'drafts' ? '送出補充' : '送出記帳'}
				title={composingReply || phase === 'drafts' ? '送出補充' : '送出記帳'}
				disabled={!$user ||
					converting ||
					!canCompose ||
					(composerCount === 0 && selectedImages.length === 0) ||
					composerCount > 500}
				onclick={() => execute()}
			>
				<Send class="h-4 w-4" aria-hidden="true" />
			</Button>
		</div>
	</div>
</div>

{#if editingDrafts && session}
	<DraftEditDialog
		{session}
		context={draftContext}
		onChange={(next) => {
			session = next;
		}}
		onClose={(changed) => {
			// Block the same outside click from dismissing the parent after the editor closes.
			closeGuard = true;
			setTimeout(() => (closeGuard = false), 400);
			editingDrafts = false;
			if (changed) {
				followLatest = true;
				conversation.push({ role: 'assistant', text: '已套用你的編輯。' });
			}
		}}
	/>
{/if}
