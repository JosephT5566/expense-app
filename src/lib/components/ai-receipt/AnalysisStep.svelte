<script lang="ts">
	import { Button } from '$lib/components/shadcn/button';
	import { RotateCcw, ArrowRight } from 'lucide-svelte';
	import { analyzeReceipt, getAIReceiptErrorInfo } from '$lib/data/ai-receipt.fetcher';
	import type { AIReceiptErrorInfo } from '$lib/data/ai-receipt.fetcher';
	import type {
		ExtractionValue,
		ReceiptAnalysisResult,
		ReceiptLineItem
	} from '$lib/types/expense';
	import Logger from '$lib/utils/logger';
	import * as Carousel from '$lib/components/shadcn/carousel';

	let {
		aiStep = $bindable(),
		aiUploading,
		aiAnalyzing = $bindable(),
		analysisResult = $bindable(),
		analysisError = $bindable(),
		previewUrls = [],
		lastUploadedFilePaths,
		onReset
	}: {
		aiStep: number;
		aiUploading: boolean;
		aiAnalyzing: boolean;
		analysisResult: ReceiptAnalysisResult | null;
		analysisError: AIReceiptErrorInfo | null;
		previewUrls: string[];
		lastUploadedFilePaths: string[];
		onReset: () => void;
	} = $props();

	function recognized<T>(field: ExtractionValue<T> | undefined): T | undefined {
		return field?.state === 'recognized' ? field.value : undefined;
	}

	function extractionLabel<T>(
		field: ExtractionValue<T> | undefined,
		format: (value: T) => string
	): string {
		if (field === undefined) {
			return '未提供';
		}
		if (field === null) {
			return '空白';
		}
		if (field.state === 'unrecognized') {
			return '無法辨識';
		}
		return format(field.value);
	}

	function itemAmount(item: ReceiptLineItem): string {
		return extractionLabel(item.line_total ?? item.unit_price, String);
	}

	async function handleReAnalyze() {
		if (!lastUploadedFilePaths || lastUploadedFilePaths.length === 0) {
			return;
		}

		aiAnalyzing = true;
		analysisResult = null;
		analysisError = null;
		try {
			const data = await analyzeReceipt(lastUploadedFilePaths);
			if (data.status === 'success' && data.result) {
				analysisResult = data.result;
			}
			Logger.log('AI Analysis Result (Re-analyze):', data);
		} catch (error) {
			console.error('Error in handleReAnalyze:', error);
			analysisError = getAIReceiptErrorInfo(error);
		} finally {
			aiAnalyzing = false;
		}
	}
</script>

{#if aiUploading || aiAnalyzing}
	<div class="py-12 flex flex-col items-center justify-center gap-4">
		<div
			class="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"
		></div>
		<div class="text-center">
			<p class="font-medium">
				{aiAnalyzing ? 'AI 分析中...' : '上傳圖片中...'}
			</p>
			<p class="text-xs text-muted-foreground mt-1">請稍候，這可能需要幾秒鐘</p>
		</div>
	</div>
{:else if analysisResult?.document_type === 'receipt'}
	{@const receipt = analysisResult.receipt}
	{@const lineItems = recognized(receipt.line_items) ?? []}
	{@const currency = recognized(receipt.currency) ?? ''}
	<div class="mt-4 space-y-4">
		<div class="flex flex-col items-center">
			{#if previewUrls.length > 1}
				<Carousel.Root class="w-full max-w-[200px]">
					<Carousel.Content>
						{#each previewUrls as url, i (i)}
							<Carousel.Item>
								<div class="p-1 flex justify-center">
									<img
										src={url}
										alt="Receipt {i + 1}"
										class="max-h-32 object-contain rounded shadow-sm"
									/>
								</div>
							</Carousel.Item>
						{/each}
					</Carousel.Content>
					<Carousel.Previous class="-left-10" />
					<Carousel.Next class="-right-10" />
				</Carousel.Root>
			{:else if previewUrls.length === 1}
				<img
					src={previewUrls[0]}
					alt="Receipt"
					class="max-h-32 object-contain rounded shadow-sm"
				/>
			{:else}
				<div
					class="h-32 w-full flex items-center justify-center bg-muted rounded border border-dashed"
				>
					<p class="text-xs text-muted-foreground">無預覽圖片</p>
				</div>
			{/if}
		</div>
		<div class="grid grid-cols-3 gap-2 text-sm border p-4 rounded-lg bg-muted/20">
			<div class="text-muted-foreground text-xs uppercase">商店</div>
			<div class="col-span-2 font-medium">
				{extractionLabel(receipt.merchant, (value) => value.name)}
			</div>
			<div class="text-muted-foreground text-xs uppercase">日期</div>
			<div class="col-span-2 font-medium">
				{extractionLabel(receipt.purchase_date, String)}
			</div>
			<div class="text-muted-foreground text-xs uppercase">金額</div>
			<div class="col-span-2 font-medium text-primary text-lg">
				{currency}
				{extractionLabel(receipt.totals, (value) => value.grand_total)}
			</div>
		</div>

		{#if lineItems.length > 0}
			<div class="space-y-2">
				<div class="text-xs font-semibold text-muted-foreground uppercase px-1">
					原始明細
				</div>
				<div class="divide-y border rounded-lg overflow-hidden bg-muted/10">
					{#each lineItems as item, i (i)}
						<div class="flex justify-between p-2 text-sm">
							<div class="flex gap-2 min-w-0">
								<span class="text-muted-foreground shrink-0">
									x{extractionLabel(item.quantity, String)}
								</span>
								<span class="truncate"
									>{extractionLabel(item.description, String)}</span
								>
							</div>
							<div class="font-medium shrink-0">{currency} {itemAmount(item)}</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="mt-6 flex gap-2 w-full">
			<Button
				variant="outline"
				class="flex-1"
				onclick={handleReAnalyze}
				disabled={aiAnalyzing}
			>
				<RotateCcw class="w-4 h-4 mr-2" /> 重新分析
			</Button>
			<Button class="flex-1" onclick={() => (aiStep = 3)}>
				下一步 <ArrowRight class="w-4 h-4 ml-2" />
			</Button>
		</div>
	</div>
{:else if analysisResult?.document_type === 'not_a_receipt'}
	<div class="py-12 text-center space-y-4">
		<p class="font-medium">上傳的圖片不是收據</p>
		<p class="text-sm text-muted-foreground">請確認圖片內容後重新上傳。</p>
		<Button variant="outline" onclick={onReset}>返回重新上傳</Button>
	</div>
{:else}
	<div class="py-12 text-center space-y-4">
		<p class="text-muted-foreground">{analysisError?.message ?? '分析失敗或無結果'}</p>
		{#if analysisError?.recovery === 'reauthenticate'}
			<Button variant="outline" onclick={() => window.location.reload()}
				>重新載入並登入</Button
			>
		{:else if lastUploadedFilePaths.length > 0 && (!analysisError || analysisError.recovery === 'retry' || analysisError.recovery === 'unknown')}
			<div class="flex flex-col gap-2">
				<Button variant="outline" onclick={handleReAnalyze} disabled={aiAnalyzing}>
					<RotateCcw class="w-4 h-4 mr-2" /> 重新分析
				</Button>
				<Button variant="ghost" onclick={onReset}>返回重新上傳</Button>
			</div>
		{:else}
			<Button variant="outline" onclick={onReset}>重新上傳</Button>
		{/if}
	</div>
{/if}
