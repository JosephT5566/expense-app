<script lang="ts">
	import type {
		ExpenseRow,
		ExtractionValue,
		PreviewExpense,
		PreviewGroupExpense,
		ReceiptAnalysisResult
	} from '$lib/types/expense';
	import * as AlertDialog from '$lib/components/shadcn/alert-dialog';
	import type { AIReceiptErrorInfo } from '$lib/data/ai-receipt.fetcher';
	import { user } from '$lib/stores/session.store';
	import { Sparkles, Upload, CircleCheckBig } from 'lucide-svelte';

	// Child components
	import StepHeader from './StepHeader.svelte';
	import UploadStep from './UploadStep.svelte';
	import AnalysisStep from './AnalysisStep.svelte';
	import ConfirmStep from './ConfirmStep.svelte';

	let {
		open,
		busy = $bindable(false),
		onImport,
		onClose
	}: {
		open: boolean;
		busy?: boolean;
		onImport?: (expenses: ExpenseRow[]) => void;
		onClose: () => void;
	} = $props();

	let aiSubmitting = $state(false);
	let aiStep = $state(1);
	let aiUploading = $state(false);
	let aiAnalyzing = $state(false);
	let aiConverting = $state(false);
	const processing = $derived(aiUploading || aiAnalyzing || aiConverting || aiSubmitting);
	$effect(() => {
		busy = processing;
	});
	let selectedFiles = $state<File[]>([]);
	let previewUrls = $state<string[]>([]);
	let lastUploadedFilePaths = $state<string[]>([]);
	let showConfirmClose = $state(false);
	let analysisError = $state<AIReceiptErrorInfo | null>(null);

	let analysisResult = $state<ReceiptAnalysisResult | null>(null);

	const wizardSteps = [
		{ id: 1, title: '上傳收據', icon: Upload },
		{ id: 2, title: 'AI 分析', icon: Sparkles },
		{ id: 3, title: '確認匯入', icon: CircleCheckBig }
	];

	let previewExpenses = $state<PreviewExpense[]>([]);
	let previewGroupExpenses = $state<PreviewGroupExpense>({});

	function recognized<T>(field: ExtractionValue<T> | undefined): T | undefined {
		return field?.state === 'recognized' ? field.value : undefined;
	}

	$effect(() => {
		if (!analysisResult || analysisResult.document_type !== 'receipt') {
			previewExpenses = [];
			return;
		}
		const receipt = analysisResult.receipt;
		const extractedItems = recognized(receipt.line_items) ?? [];
		const purchaseDate = recognized(receipt.purchase_date);
		const currency = recognized(receipt.currency) ?? 'TWD';
		const merchant = recognized(receipt.merchant)?.name ?? '';
		const grandTotal = Number(recognized(receipt.totals)?.grand_total ?? 0);
		const items =
			extractedItems.length > 0
				? extractedItems
				: [
						{
							description: { state: 'recognized' as const, value: merchant },
							quantity: { state: 'recognized' as const, value: '1' },
							line_total: {
								state: 'recognized' as const,
								value: Number.isFinite(grandTotal) ? String(grandTotal) : '0'
							}
						}
					];
		previewExpenses = items.map((item, i) => {
			const description = recognized(item.description) ?? '';
			const quantity = Number(recognized(item.quantity) ?? 1);
			const lineTotal = recognized(item.line_total);
			const unitPrice = recognized(item.unit_price);
			const amount = Number(lineTotal ?? unitPrice ?? 0) * (lineTotal ? 1 : quantity);
			return {
				id: `preview-${i}-${Date.now()}`,
				payer_email: $user?.email || '',
				note: description,
				amount: Number.isFinite(amount) ? amount : 0,
				currency,
				ts: purchaseDate
					? new Date(`${purchaseDate}T00:00:00`).toISOString()
					: new Date().toISOString(),
				scope: 'personal',
				shares_json: { [$user?.email || '']: Number.isFinite(amount) ? amount : 0 },
				is_settled: false,
				category_id: '',
				isGrouped: false,
				groupId: undefined
			} as PreviewExpense;
		});
	});

	function resetReceiptImport() {
		aiSubmitting = false;
		showConfirmClose = false;
		previewGroupExpenses = {};
		aiStep = 1;
		selectedFiles = [];
		analysisResult = null;
		aiUploading = false;
		aiAnalyzing = false;
		aiConverting = false;
		lastUploadedFilePaths = [];
		analysisError = null;
	}

	$effect(() => {
		if (open === false) {
			resetReceiptImport();
		}
	});

	$effect(() => {
		if (selectedFiles.length > 0) {
			const urls = selectedFiles.map((file) => URL.createObjectURL(file));
			previewUrls = urls;
			return () => urls.forEach((url) => URL.revokeObjectURL(url));
		} else {
			previewUrls = [];
		}
	});

	export function requestClose() {
		if (processing) {
			return;
		}
		if (aiStep > 1) {
			showConfirmClose = true;
		} else {
			onClose();
		}
	}

	function handleConfirm(expenses: ExpenseRow[]) {
		onImport?.(expenses);
		onClose();
	}
</script>

<div class="space-y-4">
	<StepHeader
		{aiStep}
		{wizardSteps}
		{aiUploading}
		aiAnalyzing={aiAnalyzing || aiSubmitting}
		onBack={() => (aiStep -= 1)}
	/>

	<div class="mt-4">
		{#if aiStep === 1}
			<UploadStep
				bind:aiStep
				bind:aiUploading
				bind:aiConverting
				bind:aiAnalyzing
				bind:selectedFiles
				{previewUrls}
				bind:lastUploadedFilePaths
				bind:analysisResult
				bind:analysisError
			/>
		{:else if aiStep === 2}
			<AnalysisStep
				bind:aiStep
				{aiUploading}
				bind:aiAnalyzing
				bind:analysisResult
				bind:analysisError
				{previewUrls}
				{lastUploadedFilePaths}
				onReset={() => (aiStep = 1)}
			/>
		{:else if aiStep === 3}
			<ConfirmStep
				bind:isSubmitting={aiSubmitting}
				bind:previewExpenses
				bind:previewGroupExpenses
				onConfirm={handleConfirm}
			/>
		{/if}
	</div>
</div>

<AlertDialog.Root bind:open={showConfirmClose}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>確認取消匯入？</AlertDialog.Title>
			<AlertDialog.Description>
				目前的進度將會遺失，且上傳的收據將不會被儲存。
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>繼續匯入</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => {
					onClose();
					showConfirmClose = false;
				}}
			>
				確認取消
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
