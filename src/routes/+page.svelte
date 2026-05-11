<script lang="ts">
	import _isEmpty from 'lodash/isEmpty';

	import type { ExpenseRow } from '$lib/types/expense';

	import * as expensesStore from '$lib/stores/expenses.store';
	import { categoryIconMap } from '$lib/stores/categories.store';

	import * as Dialog from '$lib/components/shadcn/dialog';
	import { Button } from '$lib/components/shadcn/button';
	import ExpenseDrawerContent from '$lib/components/ExpenseDrawerContent.svelte';
	import ExpenseListSection from '$lib/components/ExpenseListSection.svelte';

	import { taiwanDayBoundsISO } from '$lib/utils/dates';
	import { getMonthlyFromCacheFirst } from '$lib/data/monthly-cache-first';
	import RetrieveExpenseButton from '$lib/components/RetrieveExpenseButton.svelte';

	import { PUBLIC_GOOGLE_AI_GCF, PUBLIC_SUPABASE_URL } from '$env/static/public';
	import { supabase } from '$lib/supabase/supabaseClient';
	import Logger from '$lib/utils/logger';
	import * as jose from 'jose';
	import { Sparkles, Upload, Image as ImageIcon } from 'lucide-svelte';

	let drawerOpen = $state(false);
	let editMode = $state(false);

	let expenseId = $state('');
	const today = new Date();
	let selectedDate = $state(toDateOnlyStr(today));
	const [selectedYear, selectedMonth] = $derived(selectedDate.split('-').map(Number));
	const monthKey = $derived(`${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);

	// 改為從 store 過濾當日資料
	const expensesItems = expensesStore.items;
	const expensesLoading = expensesStore.loading;
	const dayItems = $derived.by(() => {
		const { from, to } = taiwanDayBoundsISO(selectedDate);
		return ($expensesItems ?? []).filter((e) => e.ts >= from && e.ts <= to);
	});

	// 依選擇日期，若該月份資料未在 store 中，則載入該月份
	$effect(() => {
		if (selectedDate === toDateOnlyStr(today)) {
			return;
		}

		// when state selectedDate changes
		// check if we have any item in this month in the expenses store
		if (!expensesStore.hasMonthExpenses(selectedYear, selectedMonth)) {
			getMonthlyFromCacheFirst(monthKey).then((newMonthExpense) => {
				if (_isEmpty(newMonthExpense)) {
					return;
				}
				expensesStore.setMoreItems(newMonthExpense);
			});
		}
	});

	function toDateOnlyStr(d: Date) {
		const y = d.getFullYear(),
			m = String(d.getMonth() + 1).padStart(2, '0'),
			da = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${da}`;
	}
	function isToday(dateStr: string) {
		return dateStr === toDateOnlyStr(today);
	}
	function shiftDay(delta: number) {
		if (delta > 0 && isToday(selectedDate)) {
			return;
		}
		const [y, m, d] = selectedDate.split('-').map(Number);
		const next = toDateOnlyStr(new Date(y, m - 1, d + delta));
		if (delta > 0 && next > toDateOnlyStr(today)) {
			return;
		}
		selectedDate = next;
	}

	function openCreate() {
		editMode = false;
		drawerOpen = true;
	}

	function openEdit(e: ExpenseRow) {
		editMode = true;
		expenseId = e.id;
		// 初始化分帳
		drawerOpen = true;
	}

	async function callAIGCF(fileName: string, contentType: string) {
		const {
			data: { session }
		} = await supabase.auth.getSession();
		const accessToken = session?.access_token;
		if (!accessToken) {
			console.error('No access token found');
			return;
		}

		// verify if the access token is valid using jose and jwks
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
		} catch (error) {
			console.error('Error calling AI GCF:', error);
		}
	}

	let aiDialogOpen = $state(false);
	let selectedFile = $state<File | null>(null);
	let previewUrl = $state<string | null>(null);
	let isDragging = $state(false);
	let fileInput: HTMLInputElement;

	$effect(() => {
		if (selectedFile) {
			const url = URL.createObjectURL(selectedFile);
			previewUrl = url;
			return () => URL.revokeObjectURL(url);
		} else {
			previewUrl = null;
		}
	});

	function handleFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files && input.files[0]) {
			selectedFile = input.files[0];
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
			selectedFile = e.dataTransfer.files[0];
		}
	}

	async function handleUpload() {
		if (!selectedFile) {
			return;
		}
		await callAIGCF(selectedFile.name, selectedFile.type || 'image/jpeg');
		// Signed URL logged in callAIGCF
		aiDialogOpen = false;
		selectedFile = null;
	}

	let startX = 0,
		dx = 0;
	const SWIPE = 60;
	function onTouchStart(e: TouchEvent) {
		startX = e.touches[0].clientX;
		dx = 0;
	}
	function onTouchMove(e: TouchEvent) {
		dx = e.touches[0].clientX - startX;
	}
	function onTouchEnd() {
		if (dx < -SWIPE) {
			shiftDay(+1);
		}
		if (dx > SWIPE) {
			shiftDay(-1);
		}
		startX = 0;
		dx = 0;
	}
</script>

<section
	class="card p-4"
	role="presentation"
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
>
	<div class="flex items-center justify-center relative">
		<RetrieveExpenseButton className="absolute left-0 text-[var(--c-primary)]" {monthKey} />
		<button class="px-2 py-1" onclick={() => shiftDay(-1)}>◀</button>

		<input
			type="date"
			value={selectedDate}
			class="px-3 py-1 rounded-md bg-[var(--c-bg)]"
			max={toDateOnlyStr(today)}
			oninput={(e) => {
				const target = e.target as HTMLInputElement;
				if (!target.value) {
					selectedDate = toDateOnlyStr(today);
					return;
				}
				selectedDate = target.value;
			}}
		/>
		<button
			class="px-2 py-1 disabled:opacity-40"
			disabled={isToday(selectedDate)}
			onclick={() => shiftDay(+1)}
		>
			▶
		</button>
	</div>

	{#if $expensesLoading && dayItems.length === 0}
		<p class="mt-3 opacity-70">載入中…</p>
	{:else}
		{#if dayItems.length !== 0}
			<ExpenseListSection
				items={dayItems}
				categoryIconMap={$categoryIconMap}
				onEdit={openEdit}
				showSum={true}
			/>
		{/if}
		<div class="mt-3 flex gap-2">
			<Button class="grow" onclick={openCreate}
				>{dayItems.length === 0 ? '今日第一筆記帳' : '新增項目'}</Button
			>
			<Button class="text-primary" variant="outline" onclick={() => (aiDialogOpen = true)}>
				<Sparkles class="w-5 h-5" />
			</Button>
		</div>
	{/if}
</section>

<Dialog.Root bind:open={drawerOpen}>
	<Dialog.Content class="max-h-[75vh] overflow-y-auto sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>{editMode ? '編輯項目' : '新增項目'}</Dialog.Title>
		</Dialog.Header>
		<ExpenseDrawerContent
			expenseId={editMode ? expenseId : undefined}
			{selectedDate}
			{editMode}
			onSubmitFinish={() => {
				drawerOpen = false;
			}}
		/>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={aiDialogOpen}>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>AI 記帳 - 上傳收據</Dialog.Title>
		</Dialog.Header>
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
				accept="image/jpeg,image/png,image/heic,image/heif"
				class="hidden"
				bind:this={fileInput}
				onchange={handleFileChange}
			/>
			{#if selectedFile && previewUrl}
				<div class="flex flex-col items-center w-full">
					<img
						src={previewUrl}
						alt="Preview"
						class="max-h-48 w-full object-contain mb-2 rounded shadow-sm"
					/>
					<p class="text-sm font-medium truncate max-w-full">{selectedFile.name}</p>
					<p class="text-xs text-muted-foreground">
						{(selectedFile.size / 1024 / 1024).toFixed(2)} MB
					</p>
				</div>
			{:else}
				<Upload class="w-12 h-12 text-muted-foreground mb-2" />
				<p class="text-sm">點擊或拖曳圖片至此</p>
				<p class="text-xs text-muted-foreground mt-1">支援 JPG, PNG, HEIC 格式</p>
			{/if}
		</div>
		<Dialog.Footer class="mt-4">
			<button class="btn btn-primary w-full" disabled={!selectedFile} onclick={handleUpload}>
				開始上傳
			</button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
</style>
