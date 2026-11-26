<script lang="ts">
	import {
		restoredImageUrl,
		listConversations,
		loadConversation,
		summarizeConversation,
		type PersistedConversation
	} from './persisted';
	import { chat, attempts, imagePreviews } from './conversation.svelte';

	import { onDestroy, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Button } from '$lib/components/shadcn/button';
	import Paperclip from 'lucide-svelte/icons/paperclip';
	import X from 'lucide-svelte/icons/x';
	import TriangleAlert from 'lucide-svelte/icons/triangle-alert';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import * as AlertDialog from '$lib/components/shadcn/alert-dialog';
	import * as RadioGroup from '$lib/components/shadcn/radio-group';
	import { Label } from '$lib/components/shadcn/label';
	import * as pending from './pending';
	import PendingTray from './PendingTray.svelte';
	import CreatedSummary from './CreatedSummary.svelte';
	import DraftBlock from './DraftBlock.svelte';
	import DraftEditDialog from './DraftEditDialog.svelte';
	import { fromServerDrafts, isComplete, toClientDraft, issueText } from './drafts';
	import type { SemanticResponseV3 } from '@jopie/semantic-entry-contract';
	import type { ExpenseRow } from '$lib/types/expense';
	import Send from 'lucide-svelte/icons/send';
	import { user } from '$lib/stores/session.store';
	import * as expensesStore from '$lib/stores/expenses.store';
	import { forceRefetchMonthlyExpenses } from '$lib/data/expenses.fetcher';
	import { getTaiwanMonthKey } from '$lib/utils/dates';
	import {
		submitSemanticEntry,
		getSemanticEntryStatus,
		requestImageUploads,
		uploadImage,
		SemanticEntryError
	} from '$lib/data/semantic-entry.fetcher';
	import {
		parseRequestV3,
		parseClientDraftV3,
		MAX_IMAGE_BYTES,
		MAX_TOTAL_IMAGE_BYTES,
		UPLOAD_IMAGE_TYPES,
		type UploadImageType,
		type IssueV3,
		type SemanticRequestV3
	} from '@jopie/semantic-entry-contract';

	let historyOpen = $state(false);
	let historyButton = $state<HTMLButtonElement | null>(null);
	let historyOwner = $state<string>();
	let historyRecords = $state<PersistedConversation[]>([]);
	let historyNow = $state(Date.now());
	const historyRows = $derived(
		historyRecords.map((record) => ({
			record,
			...summarizeConversation(record, historyNow)
		}))
	);
	const historyTime = new Intl.DateTimeFormat('zh-TW', {
		timeZone: 'Asia/Taipei',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	function openHistory() {
		if (chat.switchingDisabled || !chat.accountId) {
			return;
		}
		chat.flush();
		historyOwner = chat.accountId;
		historyNow = Date.now();
		try {
			const owner = historyOwner;
			historyRecords = listConversations(owner, historyNow).flatMap(({ id }) => {
				const record = loadConversation(owner, historyNow, globalThis.localStorage, id);
				return record ? [record] : [];
			});
		} catch {
			historyRecords = [];
		}
		closeTray();
		historyOpen = true;
	}
	$effect(() => {
		if (historyOwner !== chat.accountId) {
			historyOpen = false;
			historyRecords = [];
		}
	});
	$effect(() => {
		if (!historyOpen) {
			return;
		}
		const timer = setInterval(() => {
			historyNow = Date.now();
		}, 1000);
		return () => clearInterval(timer);
	});
	function selectHistory(record: PersistedConversation) {
		if (historyOwner && chat.selectConversation(historyOwner, record)) {
			editingDrafts = false;
			followLatest = true;
			historyOpen = false;
		}
	}

	let editingDrafts = $state(false);

	function onEditDrafts() {
		if (chat.readOnly) {
			return;
		}
		if (chat.session) {
			chat.session = {
				...chat.session,
				items: chat.session.items.map((item) =>
					chat.serverDraftIssues[item.id] && !item.edited
						? {
								...item,
								draft: {
									...item.draft,
									issues: chat.serverDraftIssues[item.id],
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
		chat.refreshToday();
		chat.session = fromServerDrafts(result.drafts);
		chat.serverDraftIssues = {};
		if (chat.draftRejected) {
			chat.draftAnalysis = '';
		}
		chat.draftRejected = false;
		chat.draftHeading = `找到 ${chat.drafts.length} 筆，${result.reason === 'multiple' ? '因為有多筆' : '有資料需要補齊'}，還沒記帳。`;
		if (!chat.conversation.some((entry) => entry.drafts)) {
			chat.draftAnalysis = chat.analysis;
			chat.conversation.push({
				role: 'assistant',
				text: '',
				drafts: true,
				requestId: result.requestId
			});
		}
		chat.analysis = '';
		chat.text = '';
		chat.attempt = null;
		chat.phase = 'drafts';
		if (chat.clarification?.purpose === 'split' && chat.selectedOption === 'custom') {
			chat.draftEditorRequested = true;
		}
	}

	async function confirmOption() {
		const option = chat.clarification?.options?.find((item) => item.id === chat.selectedOption);
		if (!option || chat.processing || chat.readOnly) {
			return;
		}
		chat.reply = option.label;
		await execute();
	}

	// Pending tray: a popover under the page title badge.
	let trayOpen = $state(false);
	let expandedId = $state<string | null>(null);
	let badgeElement = $state<HTMLButtonElement>();
	let trayElement = $state<HTMLDivElement>();
	// Expired items shown during the current tray opening; removed when the tray closes (§5).
	// Plain bookkeeping (not rendered), so it stays non-reactive.
	let seenExpired: string[] = [];

	let confirmId = $state<string | null>(null);
	let cancelButton = $state<HTMLButtonElement | null>(null);
	let toast = $state(false);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	let conversationElement = $state<HTMLDivElement>();
	let followLatest = true;
	$effect(() => {
		// Follow streamed updates unless the reader has scrolled back through the conversation.
		const content = [
			chat.conversation.length,
			chat.analysis,
			chat.phase,
			chat.question,
			chat.message,
			chat.savedExpense
		];
		untrack(() => {
			if (followLatest && content) {
				void tick().then(() => {
					if (!destroyed && followLatest && conversationElement?.isConnected) {
						conversationElement.scrollTop = conversationElement.scrollHeight;
					}
				});
			}
		});
	});

	let fileInput: HTMLInputElement;
	let composerElement = $state<HTMLTextAreaElement>();
	const composerMaxRows = 6;

	// Grow the composer with its content from one row up to six, then scroll inside it.
	function resizeComposer() {
		const el = composerElement;
		if (destroyed || !el?.isConnected) {
			return;
		}
		const style = getComputedStyle(el);
		const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
		const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
		const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
		const maxHeight = lineHeight * composerMaxRows + padding;
		el.style.height = 'auto';
		const contentHeight = el.scrollHeight;
		el.style.height = `${Math.min(contentHeight, maxHeight) + border}px`;
		el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
	}
	$effect(() => {
		// Re-measure whenever the bound value changes, including programmatic clears after sending.
		void (chat.composingReply ? chat.reply : chat.text);
		if (composerElement) {
			resizeComposer();
		}
	});
	$effect(() => {
		// Width changes and rotation change soft wrapping.
		const el = composerElement;
		if (!el || typeof ResizeObserver === 'undefined') {
			return;
		}
		let width = el.clientWidth;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth !== width) {
				width = el.clientWidth;
				resizeComposer();
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	});

	function clearImages() {
		chat.selectedImages.forEach((image) => URL.revokeObjectURL(image.url));
		chat.selectedImages = [];
		chat.imageError = '';
		chat.converting = false;
		chat.uploading = false;
	}
	function clearConversation() {
		imagePreviews.forEach((url) => URL.revokeObjectURL(url));
		imagePreviews.clear();
		chat.conversation = [];
		chat.session = null;
		chat.draftEditorRequested = false;
		chat.retainedCommit = null;
		editingDrafts = false;
		chat.revised = false;
		chat.serverDraftIssues = {};
		chat.draftHeading = '';
		chat.draftAnalysis = '';
		chat.draftRejected = false;
	}
	function removeImage(index: number) {
		URL.revokeObjectURL(chat.selectedImages[index].url);
		chat.selectedImages = chat.selectedImages.filter((_, i) => i !== index);
		chat.imageError = '';
	}
	async function selectImages(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (!files.length || chat.attachmentsDisabled) {
			return;
		}
		if (chat.selectedImages.length + files.length > 4) {
			chat.imageError = '最多附加 4 張圖片。';
			return;
		}
		const version = chat.revision;
		const owner = chat.accountId;
		chat.converting = true;
		const converted: File[] = [];
		try {
			for (const file of files) {
				if (
					/\.(heic|heif)$/i.test(file.name) ||
					['image/heic', 'image/heif'].includes(file.type)
				) {
					chat.imageError = '轉換 HEIC 中…';
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
						if (version === chat.revision && owner === chat.accountId) {
							chat.imageError = 'HEIC/HEIF 圖片轉換失敗，請改用 JPEG、PNG 或 WebP。';
						}
						return;
					}
				} else {
					converted.push(file);
				}
				if (version !== chat.revision || owner !== chat.accountId) {
					return;
				}
			}
			const all = [...chat.selectedImages.map((image) => image.file), ...converted];
			if (all.some((file) => !UPLOAD_IMAGE_TYPES.includes(file.type as UploadImageType))) {
				chat.imageError = '只支援 JPG、PNG、WebP、HEIC 圖片。';
			} else if (all.some((file) => file.size > MAX_IMAGE_BYTES)) {
				chat.imageError = '單張圖片不能超過 10 MiB。';
			} else if (all.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_IMAGE_BYTES) {
				chat.imageError = '圖片總計不能超過 20 MiB。';
			} else {
				chat.selectedImages = [
					...chat.selectedImages,
					...converted.map((file) => ({ file, url: URL.createObjectURL(file) }))
				];
				chat.imageError = '';
			}
		} finally {
			if (version === chat.revision && owner === chat.accountId) {
				chat.converting = false;
			}
		}
	}

	let destroyed = false;
	function clearPending(owner: string, id = chat.focusedId) {
		if (!id) {
			return;
		}
		try {
			const items = pending.remove(owner, id);
			if (owner === chat.accountId) {
				chat.pendingItems = items;
			}
		} catch {
			/* A stale item remains recoverable by lookup. */
		}
	}
	function restorePending(owner: string) {
		try {
			chat.pendingItems = pending.load(owner, Date.now());
			for (const id of attempts.keys()) {
				if (
					id !== chat.lastRequestId &&
					!chat.pendingItems.some(
						(item) => item.requestId === id && item.expiredAt === null
					)
				) {
					attempts.delete(id);
				}
			}
			checkExpiry();
		} catch {
			chat.phase = 'error';
			chat.message = '無法讀取先前請求，請先檢查此網站的儲存設定。';
		}
	}
	function freshRequestId() {
		let id = crypto.randomUUID();
		while (chat.pendingItems.some((item) => item.requestId === id)) {
			id = crypto.randomUUID();
		}
		return id;
	}
	function atLimit() {
		if (pending.activeCount(chat.pendingItems) < pending.PENDING_LIMIT) {
			return false;
		}
		showToast();
		return true;
	}
	function showToast() {
		// One toast at a time: a repeated attempt restarts the timer instead of stacking.
		toast = true;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = false), 4000);
	}
	function closeToast() {
		clearTimeout(toastTimer);
		toast = false;
	}
	function openTray(expand: string | null = null) {
		if (destroyed) {
			return;
		}
		trayOpen = true;
		expandedId = expand;
		checkExpiry();
		void tick().then(() => {
			if (!destroyed) {
				trayElement?.focus();
			}
		});
	}
	function closeTray(restoreFocus = false) {
		if (!trayOpen) {
			return;
		}
		trayOpen = false;
		expandedId = null;
		if (chat.accountId && seenExpired.length) {
			try {
				chat.pendingItems = pending.removeSeenExpired(chat.accountId, seenExpired);
			} catch {
				/* Storage is unavailable; the expired marks stay until the next close. */
			}
		}
		seenExpired = [];
		if (restoreFocus) {
			void tick().then(() => focusAfterTray());
		}
	}
	function focusAfterTray() {
		if (destroyed) {
			return;
		}
		if (trayOpen && trayElement) {
			trayElement.focus();
		} else if (badgeElement?.isConnected) {
			badgeElement.focus();
		} else {
			document.getElementById('semantic-entry-text')?.focus();
		}
	}
	function toggleTray() {
		if (trayOpen) {
			closeTray();
		} else {
			openTray();
		}
	}
	function toggleExpand(id: string) {
		expandedId = expandedId === id ? null : id;
		if (expandedId) {
			checkExpiry();
		}
	}
	$effect(() => {
		// Record every expired row displayed while the tray is open, including rows that
		// expire during this opening (§5 seen-once clearing).
		if (trayOpen) {
			for (const item of chat.pendingItems.filter(
				(item) => item.requestId !== chat.restoredRequestId
			)) {
				if (item.expiredAt !== null && !seenExpired.includes(item.requestId)) {
					seenExpired.push(item.requestId);
				}
			}
		}
	});
	$effect(() => {
		if (!trayOpen) {
			return;
		}
		// Outside clicks close only the pending tray.
		const listener = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (
				!target ||
				confirmId ||
				trayElement?.contains(target) ||
				badgeElement?.contains(target)
			) {
				return;
			}
			closeTray();
		};
		document.addEventListener('pointerdown', listener, true);
		return () => document.removeEventListener('pointerdown', listener, true);
	});
	$effect(() => {
		// While the page is mounted, re-check items past the window once a minute.
		const timer = setInterval(() => checkExpiry(), 60_000);
		return () => clearInterval(timer);
	});
	function checkExpiry() {
		if (!chat.accountId || chat.processing || chat.converting) {
			return;
		}
		const now = Date.now();
		for (const item of chat.pendingItems) {
			if (
				item.requestId !== chat.restoredRequestId &&
				item.expiredAt === null &&
				pending.isPastWindow(item, now) &&
				!chat.lookingUp.has(item.requestId)
			) {
				void lookup(item.requestId, 'auto');
			}
		}
	}
	function lookupMessage(error: unknown) {
		return error instanceof SemanticEntryError && error.code === 'configuration'
			? '文字記帳服務尚未設定。'
			: error instanceof SemanticEntryError && error.code === 'unauthorized'
				? '請重新登入。'
				: '連線中斷或逾時，請查詢結果或重試同一請求。';
	}
	function forgetPending(owner: string, id: string) {
		attempts.delete(id);
		if (chat.retainedCommit?.requestId === id) {
			chat.retainedCommit = null;
		}
		chat.lookupErrors.delete(id);
		if (expandedId === id) {
			expandedId = null;
		}
		if (chat.phase === 'uncertain' && chat.focusedId === id) {
			// The current conversation was waiting on this item; it is resolved now.
			chat.focusedId = null;
			chat.attempt = null;
			chat.history = [];
			chat.question = '';
			chat.clarification = null;
			chat.selectedOption = '';
			chat.reply = '';
			chat.message = '';
			chat.analysis = '';
			chat.phase = 'input';
		}
		if (owner === chat.accountId && !chat.pendingItems.length) {
			closeTray(true);
		}
	}
	// Status lookup for one tray item. It does not take over the conversation: a completed
	// result is applied to the store and appended to the chat as a created summary.
	async function lookup(
		id: string,
		source: 'query' | 'delete' | 'auto'
	): Promise<'completed' | 'not_found' | 'expired' | 'failed' | null> {
		const owner = chat.accountId;
		if (!owner || chat.lookingUp.has(id)) {
			return null;
		}
		const epoch = chat.lookupEpoch;
		const current = () => epoch === chat.lookupEpoch && get(user)?.id === owner;
		const lookupController = new AbortController();
		chat.lookupControllers.push(lookupController);
		chat.lookingUp.set(id, source);
		chat.lookupErrors.delete(id);
		if (chat.phase === 'uncertain' && chat.focusedId === id) {
			chat.analysis = '';
		}
		try {
			const completed = await getSemanticEntryStatus(id, lookupController.signal);
			if (!current()) {
				return null;
			}
			if (completed) {
				const note = await applyCreated(completed, current);
				if (note === null) {
					return null;
				}
				clearPending(owner, id);
				forgetPending(owner, id);
				followLatest = true;
				chat.conversation.push({
					role: 'assistant',
					text: note,
					requestId: id,
					expenses: completed.expenses
				});
				return 'completed';
			}
			const item = chat.pendingItems.find((value) => value.requestId === id);
			if (item && item.expiredAt === null && pending.isPastWindow(item, Date.now())) {
				try {
					chat.pendingItems = pending.markExpired(owner, id, Date.now());
				} catch {
					/* Storage is unavailable; keep the item pending so it can be queried again. */
					return 'not_found';
				}
				forgetPending(owner, id);
				return 'expired';
			}
			return 'not_found';
		} catch (error) {
			if (!current()) {
				return null;
			}
			if (source !== 'auto') {
				chat.lookupErrors.set(id, lookupMessage(error));
			}
			return 'failed';
		} finally {
			chat.lookupControllers = chat.lookupControllers.filter(
				(entry) => entry !== lookupController
			);
			if (epoch === chat.lookupEpoch) {
				chat.lookingUp.delete(id);
			}
		}
	}
	async function deletePending(id: string) {
		if (chat.processing || chat.converting) {
			return;
		}
		// Re-query first: a completed item is applied instead of deleted (§6).
		if ((await lookup(id, 'delete')) === 'not_found' && trayOpen) {
			confirmId = id;
		}
	}
	function cancelDelete() {
		if (confirmId) {
			confirmId = null;
		}
	}
	function confirmDelete() {
		const id = confirmId;
		confirmId = null;
		if (!id || !chat.accountId) {
			return;
		}
		clearPending(chat.accountId, id);
		forgetPending(chat.accountId, id);
	}
	function dismissExpired(id: string) {
		if (!chat.accountId) {
			return;
		}
		seenExpired = seenExpired.filter((entry) => entry !== id);
		clearPending(chat.accountId, id);
		if (!chat.pendingItems.length) {
			closeTray(true);
		}
	}
	async function retryFromTray(id: string) {
		if (
			chat.readOnly ||
			chat.processing ||
			chat.converting ||
			chat.lookingUp.has(id) ||
			!attempts.has(id)
		) {
			return;
		}
		// The retry streams in the chat, so the tray closes to show it.
		closeTray();
		if (!(chat.phase === 'uncertain' && chat.focusedId === id)) {
			// Retrying another item starts a separate conversation, like new input does.
			if (chat.failedAttempt?.history?.length) {
				chat.failedAttempt = null;
			}
			const images = chat.selectedImages;
			chat.selectedImages = [];
			newOperation(false);
			chat.selectedImages = images;
		}
		await retryPending(id);
	}
	function retainAttempt() {
		if (chat.attempt && chat.focusedId) {
			attempts.set(chat.focusedId, chat.attempt);
		}
	}

	const fields: Record<string, string> = {
		images: '圖片',
		amount: '金額',
		note: '描述',
		date: '日期',
		payerId: '付款人',
		members: '成員',
		splitMemberIds: '分攤',
		shares: '分攤金額',
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
		configuration: '服務設定不完整',
		custom_required: '請指定每人的整數分攤金額'
	};
	$effect(() => {
		const next = $user?.id;
		untrack(() => {
			trayOpen = false;
			expandedId = null;
			seenExpired = [];
			confirmId = null;
			editingDrafts = false;
			closeToast();
			if (next) {
				restorePending(next);
			}
		});
	});
	$effect(() => {
		if (chat.draftEditorRequested) {
			untrack(() => {
				chat.draftEditorRequested = false;
				onEditDrafts();
			});
		}
	});
	onDestroy(() => {
		destroyed = true;
		closeTray();
		editingDrafts = false;
		closeToast();
		conversationElement = undefined;
		composerElement = undefined;
		badgeElement = undefined;
		trayElement = undefined;
		cancelButton = null;
	});
	function startNewConversation() {
		if (!chat.switchingDisabled) {
			closeTray();
			newOperation();
		}
	}
	function newOperation(clear = true) {
		chat.clearPersisted();
		chat.refreshToday();
		const failedReply =
			!clear && chat.failedAttempt?.action === 'analyze' && chat.failedAttempt.history?.length
				? chat.failedAttempt
				: null;
		const failedClarification = failedReply ? chat.clarification : null;
		const failedOption = failedReply ? chat.selectedOption : '';
		chat.focusedId = null;
		chat.analysis = '';
		if (failedReply) {
			chat.conversation = chat.conversation.slice(0, -2);
		} else {
			clearConversation();
		}
		clearImages();
		followLatest = true;
		chat.revision++;
		chat.controller?.abort();
		chat.attempt = null;
		chat.history = [];
		chat.question = '';
		chat.clarification = null;
		chat.selectedOption = '';
		chat.reply = '';
		chat.savedExpense = null;
		if (clear) {
			chat.text = '';
		}
		chat.phase = 'input';
		if (failedReply?.history?.length) {
			chat.attempt = failedReply;
			chat.history = failedReply.history.slice(0, -1);
			chat.question = failedReply.history[failedReply.history.length - 1].question;
			chat.clarification = failedClarification;
			chat.selectedOption = failedOption;
			chat.reply = failedReply.history[failedReply.history.length - 1].answer;
			chat.phase = 'needs_input';
		}
		chat.issues = [];
		chat.message = '';
	}
	function stillCurrent(version: number, owner: string) {
		return version === chat.revision && get(user)?.id === owner;
	}

	async function accept(
		result: { expenses: ExpenseRow[]; replayed: boolean },
		version: number,
		owner: string
	) {
		if (!stillCurrent(version, owner)) {
			return;
		}
		const note = await applyCreated(result, () => stillCurrent(version, owner));
		if (note === null) {
			return;
		}
		clearPending(owner);
		if (chat.focusedId) {
			attempts.delete(chat.focusedId);
		}
		chat.failedAttempt = null;
		chat.retainedCommit = null;
		chat.focusedId = null;
		chat.message = note;
		if (
			chat.attempt?.images ||
			chat.attempt?.action === 'commit' ||
			result.expenses.length > 1
		) {
			chat.conversation = chat.conversation.filter((entry) => !entry.drafts);
			chat.session = null;
			editingDrafts = false;
			chat.revised = false;
			chat.serverDraftIssues = {};
			chat.conversation.push({
				role: 'assistant',
				text: chat.message,
				analysis: chat.analysis,
				requestId: chat.lastRequestId ?? undefined,
				expenses: result.expenses
			});
			clearImages();
			chat.attempt = null;
			chat.history = [];
			chat.question = '';
			chat.clarification = null;
			chat.selectedOption = '';
			chat.reply = '';
			chat.text = '';
			chat.analysis = '';
			chat.message = '';
			chat.phase = 'input';
		} else {
			chat.savedExpense = result.expenses[0];
			chat.attempt = null;
			chat.phase = 'created';
		}
	}
	// Apply a created result to the store (replays refresh the affected months). Returns the
	// note to show, or null when the caller is no longer current.
	async function applyCreated(
		result: { expenses: ExpenseRow[]; replayed: boolean },
		isCurrent: () => boolean
	): Promise<string | null> {
		let refreshFailed = false;
		if (result.replayed) {
			const existing = get(expensesStore.items).filter((row) =>
				result.expenses.some((saved) => saved.id === row.id)
			);
			const months = new Set(
				[...result.expenses, ...existing].map((row) => getTaiwanMonthKey(row.ts))
			);
			for (const month of months) {
				const refreshed = await forceRefetchMonthlyExpenses(month, undefined, isCurrent);
				if (!isCurrent()) {
					return null;
				}
				if (!refreshed) {
					refreshFailed = true;
				}
			}
		} else {
			result.expenses.forEach((row) => expensesStore.upsertOne(row));
		}
		if (!isCurrent()) {
			return null;
		}
		return refreshFailed
			? '先前請求已完成，但清單更新失敗，請重新整理。'
			: result.replayed
				? '這是先前請求的完成結果，清單已重新整理。'
				: '';
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
	function conversationTimestamp() {
		return new Date(chat.ensureStarted()).toISOString();
	}

	async function executeDraft(action: 'revise' | 'commit', retry = false) {
		chat.refreshToday();
		if (
			!$user ||
			chat.readOnly ||
			(!chat.session && !retry) ||
			chat.processing ||
			chat.converting ||
			(chat.phase === 'uncertain' && !retry)
		) {
			return;
		}
		if (
			!retry &&
			action === 'commit' &&
			(!chat.drafts.length || !chat.drafts.every(isComplete))
		) {
			return;
		}
		if (action === 'revise' && (!chat.text.trim() || chat.count > 500)) {
			return;
		}
		if (!retry && action === 'commit' && atLimit()) {
			return;
		}
		const owner = $user.id;
		let request: SemanticRequestV3;
		try {
			if (retry) {
				if (chat.attempt?.action !== 'commit') {
					return;
				}
				request = parseRequestV3({
					action: 'commit',
					requestId: chat.attempt.requestId,
					...(chat.attempt.referenceDate
						? { referenceDate: chat.attempt.referenceDate }
						: {}),
					drafts: chat.attempt.drafts
				});
			} else {
				// Reuse the earlier commit identity only while the normalized drafts are unchanged.
				const reuse =
					action === 'commit' &&
					chat.retainedCommit?.accountId === owner &&
					JSON.stringify(chat.drafts.map(toClientDraft).map(parseClientDraftV3)) ===
						JSON.stringify(chat.retainedCommit.drafts)
						? chat.retainedCommit
						: null;
				request = parseRequestV3({
					action,
					requestId: reuse?.requestId ?? freshRequestId(),
					referenceDate: reuse?.referenceDate ?? chat.draftContext.today,
					drafts: chat.drafts.map(toClientDraft),
					...(action === 'revise'
						? { text: chat.text, conversationStartedAt: conversationTimestamp() }
						: {})
				});
			}
			if (action === 'commit' && !retry) {
				const items = pending.add(
					owner,
					{
						requestId: request.requestId,
						submittedAt: Date.now(),
						kind: 'commit',
						draftCount: request.drafts?.length ?? 0,
						expiredAt: null
					},
					Date.now()
				);
				if (!items) {
					return;
				}
				chat.pendingItems = items;
			}
		} catch {
			chat.conversation.push({
				role: 'assistant',
				text: '目前無法保留請求，請允許此網站儲存資料後再試。'
			});
			return;
		}
		chat.attempt = { ...request, accountId: owner };
		if (action === 'commit') {
			chat.retainedCommit = chat.attempt;
		}
		chat.focusedId = action === 'commit' ? request.requestId : null;
		if (action === 'revise') {
			chat.conversation.push({ role: 'user', text: chat.text.trim() });
			chat.text = '';
			chat.revised = true;
		}
		const version = ++chat.revision;
		chat.controller = new AbortController();
		chat.phase = 'processing';
		chat.seenPersisting = false;
		chat.recovering = retry;
		chat.analysis = '';
		chat.message = '';
		followLatest = true;
		try {
			const result = await submitSemanticEntry(
				request,
				chat.controller.signal,
				() => {
					if (stillCurrent(version, owner)) {
						chat.seenPersisting = true;
						chat.phase = 'persisting';
					}
				},
				(delta) => {
					if (stillCurrent(version, owner)) {
						chat.analysis += delta.text;
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
			if (action === 'commit') {
				// Any non-created commit result is final for this id: nothing was written.
				chat.retainedCommit = null;
			}
			if (retry) {
				// A replayed non-created commit result is final: nothing was written for this id.
				attempts.delete(request.requestId);
				if (!chat.session) {
					clearPending(owner, request.requestId);
					chat.focusedId = null;
					chat.attempt = null;
					chat.analysis = '';
					chat.phase = 'input';
					chat.conversation.push({
						role: 'assistant',
						text: `未記帳：${request.drafts?.length ?? 0} 筆都沒有寫入`
					});
					return;
				}
			}
			if (result.status === 'drafts') {
				const responseAnalysis = chat.analysis;
				receiveDrafts(result);
				if (action === 'revise') {
					chat.conversation.push({
						role: 'assistant',
						text: responseAnalysis ? '' : '已更新草稿。',
						analysis: responseAnalysis
					});
				}
			} else if (action === 'commit' && result.status === 'rejected') {
				chat.draftRejected = true;
				chat.draftHeading = `未記帳：${chat.drafts.length} 筆都沒有寫入`;
				const known = new Set(chat.drafts.map((draft) => draft.draftId));
				const matching = result.draftIssues?.filter(
					(item) => known.has(item.draftId) && item.issues.length
				);
				chat.serverDraftIssues = Object.fromEntries(
					(matching ?? []).map((item) => [item.draftId, item.issues])
				);
				const unmatched =
					result.draftIssues
						?.filter((item) => !known.has(item.draftId))
						.flatMap((item) => item.issues.map(issueText)) ?? [];
				chat.draftAnalysis = [
					result.draftIssues
						? `伺服器檢查時發現 ${new Set(result.draftIssues.map((item) => item.draftId)).size} 筆有問題，草稿都還在。`
						: result.issues.map(generalIssueText).join('、'),
					...unmatched
				].join('、');
				chat.phase = 'drafts';
			} else {
				chat.conversation.push({
					role: 'assistant',
					text: [
						...(result.status === 'needs_input' ? [result.question] : []),
						...result.issues.map(generalIssueText)
					].join('、'),
					analysis: chat.analysis
				});
				chat.analysis = '';
				chat.phase = 'drafts';
			}
			chat.analysis = '';
			clearPending(owner);
			chat.focusedId = null;
			chat.attempt = null;
		} catch (error) {
			if (!stillCurrent(version, owner)) {
				return;
			}
			if (
				action === 'commit' &&
				(retry ||
					chat.seenPersisting ||
					(error instanceof SemanticEntryError && error.persisting))
			) {
				if (chat.restoredRequestId === request.requestId) {
					retainAttempt();
					chat.phase = 'uncertain';
					chat.message = '結果待確認，請查詢結果或重試同一請求。';
					editingDrafts = false;
					chat.analysis = '';
					return;
				}
				// Q8: drop the drafts block so the same batch cannot be resent under a new id;
				// the drafts stay only in the in-memory attempt for retry, and the tray opens.
				// No chat status is added: the item is handled from the tray, and the composer
				// is free for a new entry.
				retainAttempt();
				chat.attempt = null;
				chat.focusedId = null;
				chat.phase = 'input';
				chat.conversation = chat.conversation.filter((entry) => !entry.drafts);
				chat.session = null;
				editingDrafts = false;
				chat.revised = false;
				chat.serverDraftIssues = {};
				chat.draftHeading = '';
				chat.draftAnalysis = '';
				chat.draftRejected = false;
				chat.retainedCommit = null;
				chat.analysis = '';
				openTray(request.requestId);
			} else {
				chat.conversation.push({
					role: 'assistant',
					text:
						action === 'revise'
							? `沒有更新草稿：${draftError(error)}，請再送出一次。`
							: `未記帳：${draftError(error)}`
				});
				clearPending(owner);
				chat.focusedId = null;
				if (action === 'revise') {
					chat.attempt = null;
				}
				chat.phase = 'drafts';
				chat.analysis = '';
			}
		}
	}
	async function retryPending(id: string | null) {
		if (chat.readOnly || !id || !attempts.has(id)) {
			return;
		}
		const restoredResend = chat.resendAvailable;
		chat.attempt = attempts.get(id) ?? null;
		chat.focusedId = id;
		if (chat.attempt?.action === 'commit') {
			await executeDraft('commit', true);
		} else {
			await execute(id, restoredResend);
		}
	}
	async function execute(retryId?: string, restoredResend = false) {
		chat.refreshToday();
		if (chat.phase === 'drafts' && !retryId) {
			await executeDraft('revise');
			return;
		}
		if (
			chat.readOnly ||
			chat.processing ||
			chat.converting ||
			!$user ||
			(chat.optionQuestion && !chat.selectedOption)
		) {
			return;
		}
		if (!retryId && atLimit()) {
			return;
		}
		if (chat.phase === 'uncertain' && !retryId) {
			// New input starts a separate conversation, including when a commit is pending.
			// Do not resurrect an unrelated failed clarification reply into this new request.
			if (chat.failedAttempt?.history?.length) {
				chat.failedAttempt = null;
			}
			const images = chat.selectedImages;
			chat.selectedImages = [];
			newOperation(false);
			chat.selectedImages = images;
		}
		if (retryId) {
			chat.focusedId = retryId;
		}
		chat.imageError = '';
		let uploadContext: { requestId: string; referenceDate: string; text?: string } | undefined;
		const filesToUpload = chat.selectedImages.map((image) => image.file);
		const hadUncertainty = !!retryId;
		const submittedText = chat.text || chat.attempt?.text || '';
		const owner = $user.id;
		const outgoingText = hadUncertainty
			? '重試同一請求'
			: chat.phase === 'needs_input'
				? chat.reply.trim()
				: chat.text.trim();
		if (!hadUncertainty) {
			try {
				const nextHistory =
					chat.phase === 'needs_input'
						? [
								...chat.history,
								{
									question: chat.question,
									answer: chat.reply,
									...(chat.clarification?.questionId
										? { questionId: chat.clarification.questionId }
										: {}),
									...(chat.optionQuestion && chat.selectedOption
										? { optionId: chat.selectedOption }
										: {})
								}
							]
						: chat.history;
				// Image retries after a pre-persisting failure require selecting files again and a new ID.
				const reusable =
					!filesToUpload.length &&
					!nextHistory.length &&
					chat.failedAttempt?.action === 'analyze' &&
					!chat.failedAttempt.images &&
					!chat.failedAttempt.history?.length &&
					chat.failedAttempt.text === chat.text.trim().normalize('NFC')
						? chat.failedAttempt
						: null;
				const previous = chat.phase === 'needs_input' ? chat.attempt : reusable;
				const identity = {
					requestId: previous?.requestId ?? freshRequestId(),
					referenceDate: previous?.referenceDate ?? chat.draftContext.today
				};
				if (chat.count > 500) {
					return;
				}
				const request = filesToUpload.length
					? null
					: parseRequestV3({
							action: 'analyze',
							...identity,
							conversationStartedAt:
								previous?.conversationStartedAt ?? conversationTimestamp(),
							...(previous?.images
								? {
										images: previous.images,
										...(previous.text !== undefined
											? { text: previous.text }
											: {})
									}
								: { text: previous?.text ?? chat.text }),
							...(nextHistory.length &&
							(!previous?.images ||
								chat.optionQuestion ||
								chat.history.some((turn) => turn.optionId))
								? { history: nextHistory }
								: {})
						});
				const items = pending.add(
					owner,
					{
						requestId: identity.requestId,
						submittedAt: Date.now(),
						kind: 'analyze',
						...(pending.snippetOf(chat.text || previous?.text || '')
							? { snippet: pending.snippetOf(chat.text || previous?.text || '') }
							: {}),
						...(filesToUpload.length ? { imageCount: filesToUpload.length } : {}),
						expiredAt: null
					},
					Date.now()
				);
				if (!items) {
					return;
				}
				chat.pendingItems = items;
				chat.failedAttempt = null;
				if (request) {
					chat.attempt = { ...request, accountId: owner };
					chat.history = request.history ?? [];
				} else {
					uploadContext = {
						...identity,
						...(chat.text.trim() ? { text: chat.text.trim().normalize('NFC') } : {})
					};
				}
				chat.focusedId = identity.requestId;
			} catch {
				chat.message = '目前無法保留請求，請允許此網站儲存資料後再試。';
				return;
			}
		}
		let operation = chat.attempt;
		const id = retryId ?? operation?.requestId ?? chat.focusedId;
		if (!id) {
			return;
		}
		if (chat.phase === 'needs_input' || chat.phase === 'uncertain') {
			chat.conversation.push({
				role: 'assistant',
				text:
					chat.phase === 'needs_input'
						? chat.question
						: chat.message || '先前請求結果待確認。',
				...(chat.phase === 'needs_input'
					? {
							answer: outgoingText,
							...(chat.clarification?.options
								? { options: chat.clarification.options }
								: {}),
							optionId: chat.selectedOption
						}
					: {}),
				analysis: chat.phase === 'needs_input' ? chat.analysis : ''
			});
		}
		chat.conversation.push({
			role: 'user',
			text: outgoingText,
			...(!hadUncertainty && chat.selectedImages.length
				? {
						imageIds: chat.selectedImages.map((image) => {
							const id = crypto.randomUUID();
							imagePreviews.set(id, image.url);
							return id;
						})
					}
				: {})
		});
		chat.text = '';
		chat.reply = '';
		chat.selectedImages = [];
		followLatest = true;
		const version = ++chat.revision;
		chat.controller = new AbortController();
		chat.phase = 'processing';
		chat.seenPersisting = false;
		chat.recovering = !!retryId;
		chat.analysis = '';
		chat.message = '';
		chat.issues = [];
		try {
			if (operation || uploadContext) {
				if (uploadContext) {
					chat.uploading = true;
					const targets = await requestImageUploads(
						filesToUpload.map((file) => ({
							contentType: file.type as UploadImageType,
							size: file.size
						})),
						chat.controller.signal
					);
					if (!stillCurrent(version, owner)) {
						return;
					}
					for (let i = 0; i < targets.length; i++) {
						await uploadImage(targets[i], filesToUpload[i], chat.controller.signal);
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
					chat.attempt = operation;
					const imageTurn = chat.conversation.findLast((entry) => entry.imageIds?.length);
					if (imageTurn) {
						imageTurn.imagePaths = operation.images;
						imageTurn.imageCount = operation.images?.length;
					}
					chat.uploading = false;
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
					...(operation.history ? { history: operation.history } : {}),
					...(operation.action !== 'commit'
						? {
								conversationStartedAt:
									operation.conversationStartedAt ?? conversationTimestamp()
							}
						: {})
				});
				const result = await submitSemanticEntry(
					request,
					chat.controller.signal,
					() => {
						if (stillCurrent(version, owner)) {
							chat.seenPersisting = true;
							chat.phase = 'persisting';
						}
					},
					(delta) => {
						if (stillCurrent(version, owner)) {
							chat.analysis += delta.text;
						}
					}
				);
				if (!stillCurrent(version, owner)) {
					return;
				}
				if (result.status === 'created') {
					await accept(result, version, owner);
				} else if (hadUncertainty && !restoredResend) {
					chat.phase = 'uncertain';
					chat.message = '本次解析未完成寫入，但先前請求結果仍待確認。';
				} else {
					clearPending(owner);
					chat.focusedId = null;
					if (result.status === 'needs_input') {
						chat.question = result.question;
						chat.clarification = result;
						chat.selectedOption = '';
						chat.phase = 'needs_input';
					} else {
						if (result.status === 'drafts') {
							receiveDrafts(result);
						} else {
							chat.issues = result.issues;
						}
						if (result.status !== 'drafts') {
							chat.text = submittedText;
							chat.phase = 'rejected';
						}
					}
				}
			}
		} catch (error) {
			if (!stillCurrent(version, owner)) {
				return;
			}
			const failedUpload = chat.uploading;
			const uncertain =
				!failedUpload &&
				(hadUncertainty ||
					chat.seenPersisting ||
					(error instanceof SemanticEntryError && error.persisting));
			if (uncertain) {
				retainAttempt();
			}
			if (!uncertain) {
				chat.text = submittedText;
				chat.failedAttempt = chat.attempt;
				clearPending(owner);
				chat.focusedId = null;
			}
			chat.phase = uncertain ? 'uncertain' : 'error';
			chat.message =
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
				chat.uploading = false;
			}
		}
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (
			event.key === 'Escape' &&
			!event.defaultPrevented &&
			trayOpen &&
			!confirmId &&
			!editingDrafts
		) {
			closeTray(true);
		}
	}}
/>

<div class="relative flex items-center gap-2">
	<Button
		bind:ref={historyButton}
		variant="outline"
		disabled={chat.switchingDisabled}
		onclick={openHistory}>對話紀錄</Button
	>
	{@render pendingHeader()}
	<Button
		class="ml-auto"
		variant="outline"
		disabled={chat.switchingDisabled}
		onclick={startNewConversation}>新對話</Button
	>
</div>

<Dialog.Root bind:open={historyOpen}>
	<Dialog.Content
		class="w-full max-w-full sm:max-w-xl"
		showCloseButton={false}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			historyButton?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>對話紀錄</Dialog.Title>
			<Dialog.Description
				>只保存在此裝置，對話自開始起保留 24 小時。時間為台灣時間。</Dialog.Description
			>
		</Dialog.Header>
		<div class="max-h-[65vh] space-y-2 overflow-y-auto">
			{#each historyRows as item (item.id)}
				<button
					type="button"
					class="w-full space-y-1 rounded-lg border p-3 text-left hover:bg-muted disabled:opacity-50"
					disabled={chat.switchingDisabled}
					onclick={() => selectHistory(item.record)}
				>
					<span class="block break-words font-medium">{item.summary}</span>
					<span class="flex justify-between gap-2 text-xs text-muted-foreground"
						><time datetime={new Date(item.updatedAt).toISOString()}
							>{historyTime.format(item.updatedAt)}</time
						><span>{item.status}</span></span
					>
					{#if item.status === '已過期'}<span class="block text-xs text-muted-foreground"
							>對話已過期，可能無法續談，圖片可能已失效。僅供檢視。</span
						>{/if}
				</button>
			{:else}
				<p class="py-6 text-center text-muted-foreground">還沒有對話紀錄</p>
			{/each}
		</div>
		<Button
			variant="outline"
			onclick={() => {
				historyOpen = false;
			}}>關閉</Button
		>
	</Dialog.Content>
</Dialog.Root>

<div class="relative flex h-[60vh] min-h-0 touch-manipulation flex-col gap-3">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable conversation needs keyboard access.) -->
	<div
		bind:this={conversationElement}
		role="region"
		aria-label="本次對話"
		tabindex="0"
		class="min-h-0 flex-1 touch-manipulation space-y-4 overflow-y-auto overscroll-contain rounded-xl bg-muted/15 p-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
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
		{#each chat.conversation as entry, index (index)}
			{#if entry.drafts && chat.session}
				<div class="space-y-2">
					<p class="text-xs text-muted-foreground">記帳助手</p>
					{#if chat.draftAnalysis && !chat.draftRejected}<p
							class="text-xs text-muted-foreground"
						>
							Gemini 分析
						</p>
						<p class="whitespace-pre-wrap break-words">{chat.draftAnalysis}</p>{/if}
					<p class:text-destructive={chat.draftRejected}>{chat.draftHeading}</p>
					{#if chat.draftRejected}<p class="text-destructive">
							{chat.draftAnalysis}
						</p>{/if}
					<DraftBlock
						drafts={chat.drafts}
						editedIds={chat.session.items
							.filter((item) => item.edited)
							.map((item) => item.id)}
						disabled={chat.readOnly || chat.processing || chat.phase === 'uncertain'}
						{onEditDrafts}
						onCommit={() => executeDraft('commit')}
					/>
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
						{#if (entry.imagePaths || entry.imageCount) && !entry.imageIds}<div
								class="mb-2 flex gap-2"
							>
								{#each entry.imagePaths ?? Array.from({ length: entry.imageCount ?? 0 }, () => '') as path, i (i)}
									{@const url = restoredImageUrl(path)}
									{#if url}<img
											src={url}
											alt="收據圖片"
											class="h-12 w-12 rounded-lg object-cover"
										/>{:else}<div
											role="img"
											aria-label="收據圖片，圖片暫時無法顯示"
											class="rounded-lg bg-muted p-3 text-xs text-muted-foreground"
										>
											收據圖片<br />圖片暫時無法顯示
										</div>{/if}
								{/each}
							</div>{/if}
						{#if entry.imageIds}<div class="mb-2 flex gap-2">
								{#each entry.imageIds as url (url)}<img
										src={imagePreviews.get(url)}
										alt="附加圖片"
										class="h-12 w-12 rounded-lg object-cover"
									/>{/each}
							</div>{/if}
						{#if entry.options?.length}
							<RadioGroup.Root
								value={entry.optionId}
								disabled
								aria-label="已回答的選項"
							>
								{#each entry.options as option (option.id)}
									<div class="flex items-center gap-2 py-2">
										<RadioGroup.Item
											id={`answered-${index}-${option.id}`}
											value={option.id}
										/>
										<Label for={`answered-${index}-${option.id}`}
											>{option.label}</Label
										>
									</div>
								{/each}
							</RadioGroup.Root>
						{/if}
						{#if entry.answer}<p class="text-muted-foreground">
								已回答：{entry.answer}
							</p>{/if}
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
		{#if !chat.completed && (!chat.session || chat.processing || chat.analysis || chat.message)}
			<div class="flex justify-start">
				<div
					class="max-w-[90%] space-y-2 rounded-2xl rounded-tl-sm border bg-card px-3 py-2"
				>
					<p class="text-muted-foreground text-xs">記帳助手</p>
					{#if chat.phase === 'input'}
						<p>今天記了什麼？告訴我一筆支出，我會幫你記帳。</p>
					{/if}
					{#if chat.analysis}
						<div class="space-y-1">
							<p class="text-muted-foreground text-xs">Gemini 分析</p>
							<p aria-label="Gemini 分析摘要" class="whitespace-pre-wrap break-words">
								{chat.analysis}
							</p>
						</div>
					{/if}
					{#if chat.phase === 'needs_input'}
						<p role="status" class="whitespace-pre-wrap font-medium">{chat.question}</p>
						{#if chat.optionQuestion && chat.clarification?.options}
							<RadioGroup.Root
								bind:value={chat.selectedOption}
								disabled={chat.readOnly}
								aria-label="補充資訊選項"
							>
								{#each chat.clarification.options as option, index (option.id)}
									<div
										class="flex items-center gap-3 rounded-lg border px-3 py-3"
									>
										<RadioGroup.Item
											id={`semantic-option-${index}`}
											value={option.id}
										/>
										<Label
											class="flex-1 leading-normal"
											for={`semantic-option-${index}`}>{option.label}</Label
										>
									</div>
								{/each}
							</RadioGroup.Root>
							<Button
								disabled={chat.readOnly || !chat.selectedOption || !$user}
								onclick={confirmOption}>確認</Button
							>
						{/if}
					{/if}
					<div aria-live="polite" class="space-y-2">
						{#if chat.phase === 'processing'}<p role="status">
								{chat.uploading
									? '上傳圖片中…'
									: chat.attempt?.action === 'commit'
										? '記帳中…'
										: chat.analysis
											? 'Gemini 分析中…'
											: '處理中…'}
							</p>
						{:else if chat.phase === 'persisting'}<p role="status">正在記帳，請稍候…</p>
						{:else if chat.phase === 'created' && !chat.completed}<p
								class="font-semibold"
							>
								已新增
							</p>
						{:else if chat.phase === 'rejected' || chat.phase === 'error'}<p
								class="font-semibold"
							>
								未新增
							</p>
						{:else if chat.phase === 'uncertain'}<p class="font-semibold">
								結果待確認
							</p>{/if}
						{#each chat.issues as issue, index (index)}<p>
								{issue.field === 'images' && issue.code === 'not_a_receipt'
									? '圖片看起來不是收據，請重新選擇圖片。'
									: issue.code === 'too_many_drafts'
										? '一次最多 20 筆，請分批送出。'
										: `${fields[issue.field] ?? '內容'}：${codes[issue.code] ?? '資訊無效'}`}
							</p>{/each}
						{#if chat.savedExpense && chat.phase === 'created'}
							<p class="text-sm">
								{chat.savedExpense.note} · NT$ {chat.savedExpense.amount}
							</p>
							<p class="text-sm">
								{new Date(chat.savedExpense.ts).toLocaleDateString('zh-TW', {
									timeZone: 'Asia/Taipei'
								})}
							</p>
							{#each Object.entries(chat.savedExpense.shares_json) as [email, amount] (email)}
								<p class="text-sm">{email}：NT$ {amount}</p>
							{/each}
						{/if}
						{#if chat.message}<p class="text-sm">{chat.message}</p>{/if}
					</div>
					<div class="flex flex-wrap gap-2">
						{#if chat.phase === 'uncertain' && chat.restoredRequestId}
							<Button
								size="sm"
								variant="outline"
								class="border-foreground text-foreground"
								disabled={chat.readOnly}
								onclick={() => chat.lookupRestored()}>查詢結果</Button
							>
							{#if chat.resendAvailable || (chat.focusedId && attempts.has(chat.focusedId))}<Button
									size="sm"
									variant="outline"
									class="border-foreground text-foreground"
									disabled={chat.readOnly}
									onclick={() => retryPending(chat.focusedId)}
									>{chat.resendAvailable ? '重新送出' : '重試同一請求'}</Button
								>{/if}
						{:else if chat.phase === 'created' && !chat.completed && chat.savedExpense}
							<Button size="sm" onclick={() => newOperation()}>新增另一筆</Button>
						{:else if chat.phase === 'rejected' || chat.phase === 'error'}
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
			<p id="semantic-entry-hint">{chat.imageError || chat.composerHint}</p>
			{#if chat.canCompose}<span class="shrink-0 tabular-nums">{chat.composerCount}/500</span
				>{/if}
		</div>
		{#if chat.selectedImages.length}<div class="flex gap-2 px-1">
				{#each chat.selectedImages as image, i (image.url)}<div class="relative">
						<img
							src={image.url}
							alt={`第 ${i + 1} 張附圖`}
							class="h-12 w-12 rounded-lg object-cover"
						/><Button
							size="icon"
							variant="outline"
							class="absolute -right-1 -top-1 h-5 w-5 rounded-full"
							aria-label={`移除第 ${i + 1} 張圖片`}
							disabled={chat.processing || chat.converting}
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
		{#if !chat.optionQuestion || chat.clarification?.allowFreeText !== false}
			<div
				class="bg-background flex touch-manipulation items-end gap-2 rounded-2xl border p-2 focus-within:ring-2 focus-within:ring-ring"
			>
				<Button
					size="icon"
					variant="ghost"
					class="shrink-0"
					aria-label="附加圖片"
					disabled={chat.attachmentsDisabled}
					onclick={() => fileInput.click()}><Paperclip class="h-4 w-4" /></Button
				>
				<textarea
					bind:this={composerElement}
					id="semantic-entry-text"
					aria-label={chat.phase === 'drafts'
						? '補充草稿'
						: chat.composingReply
							? '補充資訊'
							: '記帳內容'}
					aria-describedby="semantic-entry-hint"
					bind:value={
						() => (chat.composingReply ? chat.reply : chat.text),
						(value) => {
							if (chat.composingReply) {
								chat.reply = value;
							} else {
								chat.text = value;
							}
						}
					}
					disabled={chat.converting ||
						!chat.canCompose ||
						(chat.phase === 'input' && chat.attempt !== null)}
					rows="1"
					class="min-w-0 flex-1 touch-manipulation resize-none overflow-y-hidden bg-transparent px-2 py-1 text-base focus-visible:outline-none md:text-sm"
					placeholder={chat.phase === 'drafts'
						? '例如：第三筆是午餐'
						: chat.composingReply
							? '輸入你的回答…'
							: '例如：今天午餐100元'}
				></textarea>
				<Button
					size="icon"
					class="shrink-0 rounded-xl"
					aria-label={chat.composingReply || chat.phase === 'drafts'
						? '送出補充'
						: '送出記帳'}
					title={chat.composingReply || chat.phase === 'drafts' ? '送出補充' : '送出記帳'}
					disabled={!$user ||
						chat.converting ||
						!chat.canCompose ||
						(chat.composerCount === 0 && chat.selectedImages.length === 0) ||
						chat.composerCount > 500}
					onclick={() => execute()}
				>
					<Send class="h-4 w-4" aria-hidden="true" />
				</Button>
			</div>
		{/if}
	</div>
	<div
		role="status"
		aria-live="polite"
		class="pointer-events-none absolute inset-x-1 bottom-24 z-20 flex justify-center"
	>
		{#if toast}
			<div
				class="pointer-events-auto flex w-full items-center gap-2 rounded-[10px] bg-[#1f2937] py-1 pr-1 pl-3 text-[12.5px] text-white shadow-[0_8px_24px_rgba(0,0,0,0.3)]"
			>
				<TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="flex-1">已有3筆待確認，暫時無法建立新對話</span>
				<Button
					variant="ghost"
					size="icon-lg"
					class="shrink-0 text-white hover:bg-white/10 hover:text-white"
					aria-label="關閉通知"
					title="關閉通知"
					onclick={closeToast}><X aria-hidden="true" /></Button
				>
			</div>
		{/if}
	</div>
</div>

{#snippet pendingHeader()}
	<PendingTray
		items={chat.pendingItems.filter((item) => item.requestId !== chat.restoredRequestId)}
		open={trayOpen}
		{expandedId}
		lookingUp={chat.lookingUp}
		errors={chat.lookupErrors}
		disabled={chat.readOnly || chat.processing || chat.converting}
		canRetry={(id) => attempts.has(id)}
		bind:badge={badgeElement}
		bind:tray={trayElement}
		onToggle={toggleTray}
		onExpand={toggleExpand}
		onQuery={(id) => void lookup(id, 'query')}
		onRetry={(id) => void retryFromTray(id)}
		onDelete={(id) => void deletePending(id)}
		onDismiss={dismissExpired}
	/>
{/snippet}

<AlertDialog.Root
	open={confirmId !== null}
	onOpenChange={(next) => {
		if (!next) {
			cancelDelete();
		}
	}}
>
	<AlertDialog.Content
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			cancelButton?.focus();
		}}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			focusAfterTray();
		}}
	>
		<AlertDialog.Header>
			<AlertDialog.Title>確定刪除這筆待確認？</AlertDialog.Title>
			<AlertDialog.Description
				>已重新查詢：仍未查到這筆記帳。它可能還在處理中，刪除後如果你重新記帳，可能會重複。</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel bind:ref={cancelButton}>取消</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-white hover:bg-destructive/90"
				onclick={confirmDelete}>仍要刪除</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

{#if editingDrafts && chat.session}
	<DraftEditDialog
		session={chat.session}
		context={chat.draftContext}
		onChange={(next) => {
			chat.session = next;
		}}
		onClose={(changed) => {
			editingDrafts = false;
			if (changed) {
				followLatest = true;
				chat.conversation.push({ role: 'assistant', text: '已套用你的編輯。' });
			}
		}}
	/>
{/if}
