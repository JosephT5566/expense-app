<script lang="ts">
	import { Button } from '$lib/components/shadcn/button';
	import { RotateCcw, ArrowRight } from 'lucide-svelte';
	import { analyzeReceipt } from '$lib/data/ai-receipt.fetcher';
	import type { ReceiptResult } from '$lib/types/expense';
	import Logger from '$lib/utils/logger';

	let {
		aiStep = $bindable(),
		aiUploading,
		aiAnalyzing = $bindable(),
		analysisResult = $bindable(),
		previewUrl,
		lastUploadedFilePath,
		onReset
	}: {
		aiStep: number;
		aiUploading: boolean;
		aiAnalyzing: boolean;
		analysisResult: ReceiptResult | null;
		previewUrl: string | null;
		lastUploadedFilePath: string;
		onReset: () => void;
	} = $props();

	async function handleReAnalyze() {
		if (!lastUploadedFilePath) {
			return;
		}

		aiAnalyzing = true;
		analysisResult = null;
		try {
			const data = await analyzeReceipt(lastUploadedFilePath);
			if (data.status === 'success' && data.result) {
				analysisResult = data.result;
			}
			Logger.log('AI Analysis Result (Re-analyze):', data);
		} catch (error) {
			console.error('Error in handleReAnalyze:', error);
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
{:else if analysisResult}
	<div class="mt-4 space-y-4">
		<div class="flex flex-col items-center">
			<img src={previewUrl} alt="Receipt" class="max-h-32 object-contain rounded shadow-sm" />
		</div>
		<div class="grid grid-cols-3 gap-2 text-sm border p-4 rounded-lg bg-muted/20">
			<div class="text-muted-foreground text-xs uppercase">商店</div>
			<div class="col-span-2 font-medium">{analysisResult.store_name}</div>
			<div class="text-muted-foreground text-xs uppercase">日期</div>
			<div class="col-span-2 font-medium">{analysisResult.date}</div>
			<div class="text-muted-foreground text-xs uppercase">金額</div>
			<div class="col-span-2 font-medium text-primary text-lg">
				${analysisResult.total_amount}
			</div>
		</div>

		{#if analysisResult.items && analysisResult.items.length > 0}
			<div class="space-y-2">
				<div class="text-xs font-semibold text-muted-foreground uppercase px-1">
					原始明細
				</div>
				<div class="divide-y border rounded-lg overflow-hidden bg-muted/10">
					{#each analysisResult.items as item, i (item.name + i)}
						<div class="flex justify-between p-2 text-sm">
							<div class="flex gap-2 min-w-0">
								<span class="text-muted-foreground shrink-0">x{item.quantity}</span>
								<span class="truncate">{item.name}</span>
							</div>
							<div class="font-medium shrink-0">${item.price}</div>
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
{:else}
	<div class="py-12 text-center">
		<p class="text-muted-foreground">分析失敗或無結果</p>
		<Button variant="outline" class="mt-4" onclick={onReset}>返回重新上傳</Button>
	</div>
{/if}
