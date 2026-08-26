<script lang="ts">
	import { Upload, ArrowRight, Camera, X } from 'lucide-svelte';
	import { Button } from '$lib/components/shadcn/button';
	import { browser } from '$app/environment';
	import Logger from '$lib/utils/logger';
	import {
		getUploadUrl,
		analyzeReceipt,
		getAIReceiptErrorInfo,
		AIReceiptAPIError,
		toReceiptAnalysisResult
	} from '$lib/data/ai-receipt.fetcher';
	import type { AIReceiptErrorCode, AIReceiptErrorInfo } from '$lib/data/ai-receipt.fetcher';
	import type { ReceiptAnalysisResult } from '$lib/types/expense';
	import * as Carousel from '$lib/components/shadcn/carousel';

	const MAX_FILES = 4;
	const MAX_FILE_BYTES = 10 * 1024 * 1024;
	const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
	const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

	let {
		aiStep = $bindable(),
		aiUploading = $bindable(),
		aiConverting = $bindable(),
		aiAnalyzing = $bindable(),
		selectedFiles = $bindable(),
		previewUrls,
		lastUploadedFilePaths = $bindable(),
		analysisResult = $bindable(),
		analysisError = $bindable()
	}: {
		aiStep: number;
		aiUploading: boolean;
		aiConverting: boolean;
		aiAnalyzing: boolean;
		selectedFiles: File[];
		previewUrls: string[];
		lastUploadedFilePaths: string[];
		analysisResult: ReceiptAnalysisResult | null;
		analysisError: AIReceiptErrorInfo | null;
	} = $props();

	let isDragging = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let cameraInput = $state<HTMLInputElement | null>(null);

	function setClientError(code: AIReceiptErrorCode, message?: string) {
		analysisError = getAIReceiptErrorInfo(new AIReceiptAPIError(message ?? code, 400, code));
	}

	function isHeic(file: File) {
		const name = file.name.toLowerCase();
		return (
			name.endsWith('.heic') ||
			name.endsWith('.heif') ||
			file.type === 'image/heic' ||
			file.type === 'image/heif'
		);
	}

	function convertedJpegName(name: string) {
		return /\.(heic|heif)$/i.test(name)
			? name.replace(/\.(heic|heif)$/i, '.jpg')
			: `${name}.jpg`;
	}

	function hasSafeFileName(name: string) {
		return (
			name.length > 0 &&
			name !== '.' &&
			name !== '..' &&
			!/[\\/]/.test(name) &&
			!Array.from(name).some((character) => character.charCodeAt(0) < 32)
		);
	}

	function validateSelection(files: File[]): AIReceiptErrorCode | null {
		if (files.length > MAX_FILES) {
			return 'TOO_MANY_IMAGES';
		}
		if (files.some((file) => !SUPPORTED_IMAGE_TYPES.has(file.type))) {
			return 'UNSUPPORTED_IMAGE_MIME_TYPE';
		}
		if (files.some((file) => !hasSafeFileName(file.name))) {
			return 'INVALID_REQUEST';
		}
		if (new Set(files.map((file) => file.name)).size !== files.length) {
			return 'INVALID_REQUEST';
		}
		if (files.some((file) => file.size > MAX_FILE_BYTES)) {
			return 'IMAGE_TOO_LARGE';
		}
		if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_BYTES) {
			return 'REQUEST_TOO_LARGE';
		}
		return null;
	}

	async function processFiles(files: FileList | File[]) {
		if (!browser) {
			return;
		}

		analysisError = null;
		if (selectedFiles.length + files.length > MAX_FILES) {
			setClientError('TOO_MANY_IMAGES');
			return;
		}

		const processedFiles: File[] = [];
		for (const file of Array.from(files)) {
			if (isHeic(file)) {
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
						new File([blob], convertedJpegName(file.name), {
							type: 'image/jpeg'
						})
					);
					Logger.log('HEIC converted to JPEG successfully');
				} catch (err) {
					console.error('HEIC conversion failed:', err);
					setClientError(
						'UNSUPPORTED_IMAGE_MIME_TYPE',
						'HEIC/HEIF 圖片轉換失敗，請改用 JPEG、PNG 或 WebP。'
					);
					return;
				} finally {
					aiConverting = false;
				}
			} else {
				processedFiles.push(file);
			}
		}

		const nextFiles = [...selectedFiles, ...processedFiles];
		const validationError = validateSelection(nextFiles);
		if (validationError) {
			setClientError(validationError);
			return;
		}
		selectedFiles = nextFiles;
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
		const validationError = validateSelection(selectedFiles);
		if (validationError) {
			setClientError(validationError);
			return;
		}
		aiStep = 2;
		aiUploading = true;
		analysisError = null;
		lastUploadedFilePaths = [];
		try {
			const filesMetadata = selectedFiles.map((file) => ({
				file_name: file.name,
				content_type: file.type
			}));

			const response = await getUploadUrl(filesMetadata);
			const uploadFilePaths: string[] = [];

			for (let i = 0; i < selectedFiles.length; i++) {
				const file = selectedFiles[i];
				const uploadData = response.uploads.find((u) => u.file_name === file.name);

				if (!uploadData?.upload_url) {
					throw new AIReceiptAPIError('Missing upload URL', 502, 'UPLOAD_FAILED');
				}

				const uploadRes = await fetch(uploadData.upload_url, {
					method: 'PUT',
					body: file,
					headers: {
						'Content-Type': file.type
					}
				});

				if (!uploadRes.ok) {
					throw new AIReceiptAPIError(
						`GCS upload failed (${uploadRes.status})`,
						uploadRes.status,
						'UPLOAD_FAILED'
					);
				}
				Logger.log(`File ${file.name} uploaded to GCS successfully`);
				uploadFilePaths.push(uploadData.file_path);
			}

			if (uploadFilePaths.length === selectedFiles.length) {
				lastUploadedFilePaths = uploadFilePaths;

				// Start analysis immediately after upload
				aiAnalyzing = true;
				analysisResult = null;
				const data = await analyzeReceipt(lastUploadedFilePaths);
				analysisResult = toReceiptAnalysisResult(data);
				Logger.log('AI Analysis Result:', data);
			} else {
				throw new AIReceiptAPIError('Not all files were uploaded', 502, 'UPLOAD_FAILED');
			}
		} catch (err) {
			console.error('Error in handleUpload:', err);
			analysisError = getAIReceiptErrorInfo(err);
			if (lastUploadedFilePaths.length === 0) {
				aiStep = 1;
			}
		} finally {
			aiUploading = false;
			aiAnalyzing = false;
		}
	}

	function removeFile(index: number) {
		selectedFiles = selectedFiles.filter((_, i) => i !== index);
		analysisError = null;
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
		accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
		class="hidden"
		bind:this={fileInput}
		onchange={handleFileChange}
	/>
	<input
		type="file"
		accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
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
			<p class="text-xs text-muted-foreground mt-1 text-center">
				支援 JPG、PNG、WebP、HEIC，最多 4 張／20 MiB
			</p>
		</div>
	{/if}
</div>

<div class="mt-6 flex flex-col gap-2">
	{#if analysisError}
		<p
			class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
			role="alert"
		>
			{analysisError.message}
		</p>
	{/if}
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
			onclick={() => {
				selectedFiles = [];
				analysisError = null;
			}}
		>
			重新選取
		</Button>
	{/if}
</div>
