<script lang="ts">
	import { Upload, ArrowRight } from 'lucide-svelte';
	import { Button } from '$lib/components/shadcn/button';
	import { browser } from '$app/environment';
	import Logger from '$lib/utils/logger';

	let {
		aiStep = $bindable(),
		aiUploading = $bindable(),
		aiConverting = $bindable(),
		aiAnalyzing,
		selectedFile = $bindable(),
		previewUrl,
		lastUploadedFilePath = $bindable(),
		callAIGCF,
		callAnalyzeReceipt
	}: {
		aiStep: number;
		aiUploading: boolean;
		aiConverting: boolean;
		aiAnalyzing: boolean;
		selectedFile: File | null;
		previewUrl: string | null;
		lastUploadedFilePath: string;
		callAIGCF: (fileName: string, contentType: string) => Promise<any>;
		callAnalyzeReceipt: (filePath: string) => Promise<void>;
	} = $props();

	let isDragging = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	async function processFile(file: File) {
		if (!browser) return;

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
				selectedFile = new File([blob], file.name.replace(/\.heic$/i, '.jpg'), {
					type: 'image/jpeg'
				});
				Logger.log('HEIC converted to JPEG successfully');
			} catch (err) {
				console.error('HEIC conversion failed:', err);
				selectedFile = file;
			} finally {
				aiConverting = false;
			}
		} else {
			selectedFile = file;
		}
	}

	function handleFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files && input.files[0]) {
			processFile(input.files[0]);
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
			processFile(e.dataTransfer.files[0]);
		}
	}

	async function handleUpload() {
		if (!selectedFile) return;
		aiStep = 2;
		aiUploading = true;
		try {
			const contentType = selectedFile.type || 'image/jpeg';
			const signedUrlData = await callAIGCF(selectedFile.name, contentType);

			if (signedUrlData?.upload_url) {
				const uploadRes = await fetch(signedUrlData.upload_url, {
					method: 'PUT',
					body: selectedFile,
					headers: {
						'Content-Type': contentType
					}
				});

				if (uploadRes.ok) {
					Logger.log('File uploaded to GCS successfully');
					lastUploadedFilePath = signedUrlData.file_path;
					await callAnalyzeReceipt(lastUploadedFilePath);
				} else {
					console.error('GCS Upload failed:', uploadRes.statusText);
					aiStep = 1;
				}
			}
		} catch (err) {
			console.error('Error in handleUpload:', err);
			aiStep = 1;
		} finally {
			aiUploading = false;
		}
	}
</script>

<div
	class="mt-4 border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center transition-colors {isDragging
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
		accept="image/jpeg,image/png,image/heic,image/heif"
		class="hidden"
		bind:this={fileInput}
		onchange={handleFileChange}
	/>
	{#if aiConverting}
		<div class="flex flex-col items-center gap-2">
			<div
				class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"
			></div>
			<p class="text-sm">轉換 HEIC 中...</p>
		</div>
	{:else if selectedFile && previewUrl}
		<div class="flex flex-col items-center w-full">
			<img
				src={previewUrl}
				alt="Preview"
				class="max-h-48 w-full object-contain mb-2 rounded shadow-sm"
			/>
			<p class="text-sm font-medium truncate max-w-full">
				{selectedFile.name}
			</p>
			<p class="text-xs text-muted-foreground">
				{(selectedFile.size / 1024 / 1024).toFixed(2)} MB
			</p>
		</div>
	{:else}
		<Upload class="w-12 h-12 text-muted-foreground mb-2" />
		<p class="text-sm font-medium">點擊或拖曳圖片至此</p>
		<p class="text-xs text-muted-foreground mt-1">支援 JPG, PNG, HEIC 格式</p>
	{/if}
</div>

<div class="mt-6 flex flex-col gap-2">
	<Button
		class="w-full"
		disabled={!selectedFile || aiUploading || aiConverting || aiAnalyzing}
		onclick={handleUpload}
	>
		開始上傳並分析 <ArrowRight class="w-4 h-4 ml-2" />
	</Button>
</div>
