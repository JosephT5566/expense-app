<script lang="ts">
	import Icon from '@iconify/svelte';
	let { amountNum = $bindable(0) } = $props();

	let calcExpr = $state('');
	let errorMsg = $state('');
	// 運算子對應的 MDI 圖示（含新鍵）
	const OP_ICONS: Record<string, string> = {
		'+': 'mdi:plus',
		'-': 'mdi:minus',
		'*': 'mdi:multiply',
		'/': 'mdi:division',
		'<-': 'mdi:backspace-outline',
		'+/-': 'mdi:plus-minus-variant'
	};
	const isOperator = (k: string) => ['+', '-', '*', '/', '<-', '+/-'].includes(k);

	const KEYS = [
		'<-', 'C', '(', ')',
		'7', '8', '9', '/',
		'4', '5', '6', '*',
		'1', '2', '3', '-',
		'+/-', '0', '.', '+',
	] as const;

	function tapKey(k: string) {
		if (k === 'C') {
			calcExpr = '';
			amountNum = 0;
			errorMsg = '';
			return;
		}

		// 刪除最後一個字元
		if (k === '<-') {
			if (calcExpr.length > 0) {
				calcExpr = calcExpr.slice(0, -1);
			}
			errorMsg = '';
			return;
		}

		// +/-：切換結尾數字的正負號
		if (k === '+/-') {
			if (!calcExpr) {
				calcExpr = '-';
				errorMsg = '';
				return;
			}
			let i = calcExpr.length - 1;
			// 尋找最後一段數字（含小數點）
			while (i >= 0 && /[0-9.]/.test(calcExpr[i])) {
				i--;
			}
			const start = i + 1;
			// 若結尾不是數字則不處理
			if (start >= calcExpr.length) {
				return;
			}
			// 如果數字前面緊接著的是負號，且再前一個位置是運算子或左括號或字串起點，則視為該數字的符號，移除它
			if (
				start - 1 >= 0 &&
				calcExpr[start - 1] === '-' &&
				(start - 2 < 0 || /[+\-*/(]/.test(calcExpr[start - 2]))
			) {
				calcExpr = calcExpr.slice(0, start - 1) + calcExpr.slice(start);
			} else {
				// 否則在數字前插入負號
				calcExpr = calcExpr.slice(0, start) + '-' + calcExpr.slice(start);
			}
			errorMsg = '';
			return;
		}

		if (k === '=') {
			// 允許數字、運算子、空白與括號
			if (!/^[0-9+\-*/().\s]+$/.test(calcExpr)) {
				errorMsg = '輸入包含不支援的字元';
				return;
			}
			try {
				const val = Function(`"use strict";return (${calcExpr})`)();
				if (typeof val === 'number' && isFinite(val)) {
					const result = String(Math.round(val * 100) / 100);
					amountNum = Number(result);
					calcExpr = result;
					errorMsg = '';
				} else {
					errorMsg = '計算結果無效';
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				errorMsg = `計算錯誤：${msg}`;
			}
			return;
		}

		// 其他輸入：追加字元並清除錯誤
		calcExpr += k;
		errorMsg = '';
	}

	export function resetCal () {
		calcExpr = String(amountNum);
	}
</script>

<div class="card p-3">
	<div class="mb-2 text-sm opacity-80">計算機</div>
	<div class="p-2 rounded-lg border border-black/10 mb-1 min-h-[2.25rem]">{calcExpr || '0'}</div>
	{#if errorMsg}
		<div class="text-xs text-red-600 mb-2" role="alert" aria-live="polite">{errorMsg}</div>
	{/if}
	<div class="grid grid-cols-4 gap-2">
		{#each KEYS as k (k)}
			<button
				class="p-3 rounded-lg border border-black/10 flex items-center justify-center"
				onclick={() => tapKey(k)}
				aria-label={k}
			>
				{#if isOperator(k)}
					<Icon icon={OP_ICONS[k]} width="20" height="20" />
				{:else}
					{k}
				{/if}
			</button>
		{/each}
		<button class="col-span-4 btn btn-primary" onclick={() => tapKey('=')}>=</button>
	</div>
	<div class="text-xs mt-2 opacity-70">按 = 將結果填入「金額」。</div>
</div>
