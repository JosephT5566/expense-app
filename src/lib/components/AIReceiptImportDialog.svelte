<script lang="ts">
	import type { ExpenseRow, Currency, PreviewExpense, PreviewGroupExpense } from '$lib/types/expense';
	import * as Dialog from '$lib/components/shadcn/dialog';
	import { Button } from '$lib/components/shadcn/button';
	import { user } from '$lib/stores/session.store';
	import { PUBLIC_GOOGLE_AI_GCF, PUBLIC_SUPABASE_URL } from '$env/static/public';
	import { supabase } from '$lib/supabase/supabaseClient';
	import Logger from '$lib/utils/logger';
	import * as jose from 'jose';
	import { Sparkles, Upload, CircleCheckBig } from 'lucide-svelte';

	// Child components
	import StepHeader from './ai-receipt/StepHeader.svelte';
	import UploadStep from './ai-receipt/UploadStep.svelte';
	import AnalysisStep from './ai-receipt/AnalysisStep.svelte';
	import ConfirmStep from './ai-receipt/ConfirmStep.svelte';

	let {
		open = $bindable(false),
		onImport = undefined as ((expenses: ExpenseRow[]) => void) | undefined
	}: {
		open: boolean;
		onImport?: (expenses: ExpenseRow[]) => void;
	} = $props();

	let aiStep = $state(3);
	let aiUploading = $state(false);
	let aiAnalyzing = $state(false);
	let aiConverting = $state(false);
	let selectedFile = $state<File | null>(null);
	let previewUrl = $state<string | null>(null);
	let lastUploadedFilePath = $state('');
	// uploads/4b39017c-3ebb-466a-8ed2-3cbbfc8340e2/20260512032836_IMG_4146.jpg

	interface ReceiptItem {
		name: string;
		quantity: number;
		price: number;
	}
	interface ReceiptResult {
		store_name: string;
		date: string;
		total_amount: number;
		currency: string;
		items: ReceiptItem[];
	}
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
		// aiStep = 1;
		selectedFile = null;
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
		if (selectedFile) {
			const url = URL.createObjectURL(selectedFile);
			previewUrl = url;
			return () => URL.revokeObjectURL(url);
		} else {
			previewUrl = null;
		}
	});

	async function callAIGCF(fileName: string, contentType: string) {
		const {
			data: { session }
		} = await supabase.auth.getSession();
		const accessToken = session?.access_token;
		if (!accessToken) {
			console.error('No access token found');
			return;
		}

		try {
			const JWKS = jose.createRemoteJWKSet(
				new URL(`${PUBLIC_SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
			);
			const { payload } = await jose.jwtVerify(accessToken, JWKS);
			Logger.log('Access token verified using jose:', payload);
		} catch (error) {
			console.error('Token verification failed:', error);
			return;
		}

		try {
			const url = new URL(PUBLIC_GOOGLE_AI_GCF);
			url.searchParams.set('action', 'get_upload_url');
			url.searchParams.set('file_name', fileName);
			url.searchParams.set('content_type', contentType);

			const response = await fetch(url.toString(), {
				headers: {
					Authorization: `Bearer ${accessToken}`
				}
			});
			const signedUrl = await response.json();
			Logger.log('Received signed URL from GCF:', signedUrl);
			return signedUrl;
		} catch (error) {
			console.error('Error calling AI GCF:', error);
			return null;
		}
	}

	async function callAnalyzeReceipt(filePath: string) {
		if (!filePath) {
			return;
		}
		aiStep = 2;
		aiAnalyzing = true;
		analysisResult = null;

		const {
			data: { session }
		} = await supabase.auth.getSession();
		const accessToken = session?.access_token;
		if (!accessToken) {
			console.error('No access token found');
			aiAnalyzing = false;
			return;
		}

		try {
			const url = new URL(PUBLIC_GOOGLE_AI_GCF);
			url.searchParams.set('action', 'analyze_receipt');
			url.searchParams.set('file_path', filePath);

			Logger.log('Triggering AI analysis for:', filePath);
			const response = await fetch(url.toString(), {
				headers: {
					Authorization: `Bearer ${accessToken}`
				}
			});

			const data = await response.json();
			if (data.status === 'success' && data.result) {
				analysisResult = data.result;
			}
			Logger.log('AI Analysis Result:', data);
		} catch (error) {
			console.error('Error calling analyze_receipt:', error);
		} finally {
			aiAnalyzing = false;
		}
	}

	function handleConfirm(expenses: ExpenseRow[]) {
		onImport?.(expenses);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-[425px] max-h-[90vh] overflow-hidden flex flex-col">
		<StepHeader
			{aiStep}
			{wizardSteps}
			{aiUploading}
			{aiAnalyzing}
			onBack={() => (aiStep -= 1)}
		/>
		<Button
			variant="outline"
			onclick={() => {
				analysisResult = {
					store_name: '好市多股份有限公司汐止分公司',
					date: '2026-04-18',
					total_amount: 2708,
					currency: 'TWD',
					items: [
						{
							name: '桂格有機燕麥片',
							quantity: 1,
							price: 415
						},
						{
							name: 'IRISWOOZOO循環扇',
							quantity: 1,
							price: 1229
						},
						{
							name: '蚵仔煎洋芋片',
							quantity: 1,
							price: 198
						},
						{
							name: '北海鱈魚香絲600G',
							quantity: 1,
							price: 299
						},
						{
							name: '富士山氣泡水檸檬',
							quantity: 1,
							price: 369
						},
						{
							name: '黑標紅酒瓶售',
							quantity: 1,
							price: 198
						}
					]
				};
			}}
		>
			Load data
		</Button>

		<div class="flex-1 overflow-y-auto px-1">
			{#if aiStep === 1}
				<UploadStep
					bind:aiStep
					bind:aiUploading
					bind:aiConverting
					{aiAnalyzing}
					bind:selectedFile
					{previewUrl}
					bind:lastUploadedFilePath
					{callAIGCF}
					{callAnalyzeReceipt}
				/>
			{:else if aiStep === 2}
				<AnalysisStep
					bind:aiStep
					{aiUploading}
					{aiAnalyzing}
					{analysisResult}
					{previewUrl}
					{lastUploadedFilePath}
					{callAnalyzeReceipt}
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
