<script lang="ts">
	import type {
		ExpenseRow,
		Currency,
		PreviewExpense,
		PreviewGroupExpense,
		ReceiptResult
	} from '$lib/types/expense';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import * as AlertDialog from '$lib/components/shadcn/alert-dialog';
	import { Button } from '$lib/components/shadcn/button';
	import { user } from '$lib/stores/session.store';
	import { Sparkles, Upload, CircleCheckBig, X } from 'lucide-svelte';

	// Child components
	import StepHeader from './ai-receipt/StepHeader.svelte';
	import UploadStep from './ai-receipt/UploadStep.svelte';
	import AnalysisStep from './ai-receipt/AnalysisStep.svelte';
	import ConfirmStep from './ai-receipt/ConfirmStep.svelte';
	// import { mockReceiptResult } from './ai-receipt/mock';

	let {
		open = $bindable(false),
		onImport = undefined as ((expenses: ExpenseRow[]) => void) | undefined
	}: {
		open: boolean;
		onImport?: (expenses: ExpenseRow[]) => void;
	} = $props();

	let aiStep = $state(1);
	let aiUploading = $state(false);
	let aiAnalyzing = $state(false);
	let aiConverting = $state(false);
	let selectedFiles = $state<File[]>([]);
	let previewUrls = $state<string[]>([]);
	let lastUploadedFilePaths = $state<string[]>([]);
	let showConfirmClose = $state(false);

	let analysisResult = $state<ReceiptResult | null>(null);

	const wizardSteps = [
		{ id: 1, title: '上傳收據', icon: Upload },
		{ id: 2, title: 'AI 分析', icon: Sparkles },
		{ id: 3, title: '確認匯入', icon: CircleCheckBig }
	];

	let previewExpenses = $state<PreviewExpense[]>([]);
	let previewGroupExpenses = $state<PreviewGroupExpense>({});

	$effect(() => {
		if (!analysisResult) {
			previewExpenses = [];
			return;
		}
		previewExpenses = (analysisResult.items ?? []).map((item, i) => {
			return {
				id: `preview-${i}-${Date.now()}`,
				payer_email: $user?.email || '',
				note: item.name || '',
				amount: item.price || 0,
				currency: (analysisResult?.currency as Currency) || 'TWD',
				ts: analysisResult?.date
					? new Date(analysisResult.date).toISOString()
					: new Date().toISOString(),
				scope: 'personal',
				shares_json: { [$user?.email || '']: item.price || 0 },
				is_settled: false,
				category_id: '',
				isGrouped: false,
				groupId: undefined
			} as PreviewExpense;
		});
	});

	function resetAIDialog() {
		aiStep = 1;
		selectedFiles = [];
		analysisResult = null;
		aiUploading = false;
		aiAnalyzing = false;
	}

	$effect(() => {
		if (open === false) {
			resetAIDialog();
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

	function handleConfirm(expenses: ExpenseRow[]) {
		onImport?.(expenses);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="sm:max-w-[425px] max-h-[90vh] overflow-hidden flex flex-col"
		onInteractOutside={(e) => {
			if (aiStep > 1) {
				e.preventDefault();
				showConfirmClose = true;
			}
		}}
		onEscapeKeydown={(e) => {
			if (aiStep > 1) {
				e.preventDefault();
				showConfirmClose = true;
			}
		}}
		showCloseButton={aiStep === 1}
	>
		{#if aiStep > 1}
			<Button
				variant="ghost"
				class="absolute right-2 top-2 h-8 w-8 p-0"
				onclick={() => (showConfirmClose = true)}
			>
				<X class="h-4 w-4" />
				<span class="sr-only">Close</span>
			</Button>
		{/if}

		<StepHeader
			{aiStep}
			{wizardSteps}
			{aiUploading}
			{aiAnalyzing}
			onBack={() => (aiStep -= 1)}
		/>
		<!-- <Button
			variant="outline"
			onclick={() => {
				analysisResult = mockReceiptResult;
				aiStep = 3;
			}}
		>
			Load mock data
		</Button> -->

		<div class="flex-1 overflow-y-auto px-1">
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
				/>
			{:else if aiStep === 2}
				<AnalysisStep
					bind:aiStep
					{aiUploading}
					bind:aiAnalyzing
					bind:analysisResult
					{previewUrls}
					{lastUploadedFilePaths}
					onReset={() => (aiStep = 1)}
				/>
			{:else if aiStep === 3}
				<ConfirmStep
					bind:previewExpenses
					bind:previewGroupExpenses
					onConfirm={handleConfirm}
				/>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

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
					open = false;
					showConfirmClose = false;
				}}
			>
				確認取消
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
