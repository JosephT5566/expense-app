<script lang="ts">
	import { Upload, ArrowRight, Camera, X } from 'lucide-svelte';
	import { Button } from '$lib/components/shadcn/button';
	import { browser } from '$app/environment';
	import Logger from '$lib/utils/logger';
	import { getUploadUrl, analyzeReceipt } from '$lib/data/ai-receipt.fetcher';
	import type { ReceiptResult } from '$lib/types/expense';
	import * as Carousel from '$lib/components/shadcn/carousel';

	let {
		aiStep = $bindable(),
		aiUploading = $bindable(),
		aiConverting = $bindable(),
		aiAnalyzing = $bindable(),
		selectedFiles = $bindable(),
		previewUrls,
		lastUploadedFilePaths = $bindable(),
		analysisResult = $bindable()
	}: {
		aiStep: number;
		aiUploading: boolean;
		aiConverting: boolean;
		aiAnalyzing: boolean;
		selectedFiles: File[];
		previewUrls: string[];
		lastUploadedFilePaths: string[];
		analysisResult: ReceiptResult | null;
	} = $props();

	let isDragging = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let cameraInput = $state<HTMLInputElement | null>(null);

	async function processFiles(files: FileList | File[]) {
		if (!browser) {
			return;
		}

		const processedFiles: File[] = [];
		for (const file of Array.from(files)) {
			const isHeic = file.name.toLowerCase().endsWith('.heic') || file.type === 'image/heic';
			if (isHeic) {
				aiConverting = true;
				try {
					const heic2any = (await import('heic2any')).default;
					const convertedBlob = await heic2any({
						blob: file,
						toType: 'image/jpeg',
						quality: 0.7
					});
					const blob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
					processedFiles.push(
						new File([blob], file.name.replace(/\.heic$/i, '.jpg'), {
							type: 'image/jpeg'
						})
					);
					Logger.log('HEIC converted to JPEG successfully');
				} catch (err) {
					console.error('HEIC conversion failed:', err);
					processedFiles.push(file);
				} finally {
					aiConverting = false;
				}
			} else {
				processedFiles.push(file);
			}
		}
		selectedFiles = [...selectedFiles, ...processedFiles];
	}

	function handleFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			processFiles(input.files);
			input.value = ''; // Reset to allow re-selection
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
			processFiles(e.dataTransfer.files);
		}
	}

	async function handleUpload() {
		if (selectedFiles.length === 0) {
			return;
		}
		aiStep = 2;
		aiUploading = true;
		try {
			const filesMetadata = selectedFiles.map((file) => ({
				file_name: file.name,
				content_type: file.type || 'image/jpeg'
			}));

			const response = await getUploadUrl(filesMetadata);
			const uploadFilePaths: string[] = [];

			for (let i = 0; i < selectedFiles.length; i++) {
				const file = selectedFiles[i];
				const uploadData = response.uploads.find((u) => u.file_name === file.name);

				if (uploadData?.upload_url) {
					const uploadRes = await fetch(uploadData.upload_url, {
						method: 'PUT',
						body: file,
						headers: {
							'Content-Type': file.type || 'image/jpeg'
						}
					});

					if (uploadRes.ok) {
						Logger.log(`File ${file.name} uploaded to GCS successfully`);
						uploadFilePaths.push(uploadData.file_path);
					} else {
						console.error(`GCS Upload failed for ${file.name}:`, uploadRes.statusText);
					}
				}
			}

			if (uploadFilePaths.length > 0) {
				lastUploadedFilePaths = uploadFilePaths;

				// Start analysis immediately after upload
				aiAnalyzing = true;
				analysisResult = null;
				const data = await analyzeReceipt(lastUploadedFilePaths);
				if (data.status === 'success' && data.result) {
					analysisResult = data.result;
				}
				Logger.log('AI Analysis Result:', data);
			} else {
				aiStep = 1;
			}
		} catch (err) {
			console.error('Error in handleUpload:', err);
			aiStep = 1;
		} finally {
			aiUploading = false;
			aiAnalyzing = false;
		}
	}

	function removeFile(index: number) {
		selectedFiles = selectedFiles.filter((_, i) => i !== index);
	}
</script>

<div
	class="mt-4 border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center transition-colors {isDragging
		? 'border-primary bg-primary/10'
		: 'border-muted'}"
	role="button"
	tabindex="0"
	onpointerenter={() => (isDragging = true)}
	onpointerleave={() => (isDragging = false)}
	ondragover={(e) => {
		e.preventDefault();
		isDragging = true;
	}}
	ondragleave={() => (isDragging = false)}
	ondrop={handleDrop}
	onclick={() => fileInput?.click()}
	onkeydown={(e) => e.key === 'Enter' && fileInput?.click()}
>
	<input
		type="file"
		multiple
		accept="image/jpeg,image/png,image/heic,image/heif"
		class="hidden"
		bind:this={fileInput}
		onchange={handleFileChange}
	/>
	<input
		type="file"
		accept="image/*"
		capture="environment"
		class="hidden"
		bind:this={cameraInput}
		onchange={handleFileChange}
	/>
	{#if aiConverting}
		<div class="flex flex-col items-center gap-2 py-8">
			<div
				class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"
			></div>
			<p class="text-sm">轉換 HEIC 中...</p>
		</div>
	{:else if selectedFiles.length > 0}
		<div class="w-full px-8" onclick={(e) => e.stopPropagation()} role="presentation">
			<Carousel.Root class="w-full">
				<Carousel.Content>
					{#each previewUrls as url, i (`${url}-${i}`)}
						<Carousel.Item>
							<div class="relative flex flex-col items-center p-2">
								<img
									src={url}
									alt="Preview"
									class="max-h-48 w-full object-contain mb-2 rounded shadow-sm"
								/>
								<Button
									class="absolute top-0 right-0 text-destructive rounded-full shadow-md hover:bg-destructive/90 transition-colors"
									variant="outline"
									size="icon"
									onclick={() => removeFile(i)}
									aria-label="Remove image"
								>
									<X class="w-3 h-3" />
								</Button>
								<p class="text-xs font-medium truncate max-w-full px-4">
									{selectedFiles[i]?.name || ''}
								</p>
							</div>
						</Carousel.Item>
					{/each}
				</Carousel.Content>
				{#if previewUrls.length > 1}
					<Carousel.Previous class="-left-8" />
					<Carousel.Next class="-right-8" />
				{/if}
			</Carousel.Root>
		</div>
	{:else}
		<div class="py-8 flex flex-col items-center">
			<Upload class="w-12 h-12 text-muted-foreground mb-2" />
			<p class="text-sm font-medium">點擊或拖曳多張收據至此</p>
			<p class="text-xs text-muted-foreground mt-1 text-center">支援 JPG, PNG, HEIC 格式</p>
		</div>
	{/if}
</div>

<div class="mt-6 flex flex-col gap-2">
	{#if selectedFiles.length === 0}
		<Button class="w-full flex md:hidden" onclick={() => cameraInput?.click()}>
			<Camera class="w-4 h-4 mr-2" /> 拍照
		</Button>
	{:else}
		<Button
			class="w-full"
			disabled={aiUploading || aiConverting || aiAnalyzing}
			onclick={handleUpload}
		>
			開始上傳並分析 ({selectedFiles.length}) <ArrowRight class="w-4 h-4 ml-2" />
		</Button>
		<Button
			variant="ghost"
			class="w-full"
			disabled={aiUploading || aiConverting || aiAnalyzing}
			onclick={() => (selectedFiles = [])}
		>
			重新選取
		</Button>
	{/if}
</div>
