<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { sessionStore } from '$lib/stores/session.store';
	import {
		effectiveQuery,
		scopeFilter,
		settledFilter,
		searchFilter,
		dateRange,
	} from '$lib/stores/filters.store';
	import { expensesStore } from '$lib/stores/expenses.store';
	import { get } from 'svelte/store';
	import { supabase } from '$lib/supabase/supabaseClient';

	const { user, loading: sessionLoading } = sessionStore;
	const { items, loading, nextCursor, load, loadMore, markSettled, reset } = expensesStore;

	let unsubQuery: (() => void) | null = null;

	function startExpensesAutoload() {
		// 立即載入一次目前條件
		const q = get(effectiveQuery);
		load(q);
		// 訂閱條件變更
		unsubQuery = effectiveQuery.subscribe((q) => load(q));
	}

	onMount(() => {
		// 若使用者已登入，啟動資料載入
		const loadExpenses = user.subscribe(($u) => {
			if ($u) {
				startExpensesAutoload();
			} else {
				// 未登入時清空列表
				reset();
				if (unsubQuery) {
					unsubQuery();
					unsubQuery = null;
				}
			}
		});

		return () => loadExpenses();
	});

	onDestroy(() => {
		if (unsubQuery) {
			unsubQuery();
		}
	});

	async function signInWithGoogle() {
		await supabase.auth.signInWithOAuth({ provider: 'google' });
	}

	async function signOut() {
		await supabase.auth.signOut();
	}

	function toggle(id: string, next: boolean) {
		markSettled(id, next);
	}
</script>

<div>
	<!-- 控制列 -->
	<div class="controls">
		<select bind:value={$scopeFilter} disabled={!$user}>
			<option value="all">全部</option>
			<option value="household">家庭</option>
			<option value="personal">個人</option>
		</select>

		<select bind:value={$settledFilter} disabled={!$user}>
			<option value="all">全部</option>
			<option value="only_unsettled">未結清</option>
			<option value="only_settled">已結清</option>
		</select>

		<input placeholder="搜尋標題…" bind:value={$searchFilter} disabled={!$user} />
		<!-- 日期可以用你的 datepicker，這裡用字串佔位 -->
		<input
			placeholder="from (YYYY-MM-DD)"
			on:change={(e) => dateRange.set({ ...$dateRange, from: e.currentTarget.value })}
			disabled={!$user}
		/>
		<input
			placeholder="to (YYYY-MM-DD)"
			on:change={(e) => dateRange.set({ ...$dateRange, to: e.currentTarget.value })}
			disabled={!$user}
		/>

		{#if $user}
			<button on:click={signOut}>登出</button>
		{:else}
			<button on:click={signInWithGoogle} disabled={$sessionLoading}>使用 Google 登入</button>
		{/if}
	</div>

	{#if $sessionLoading}
		<p>檢查登入狀態中…</p>
	{:else if !$user}
		<p>請先登入以查看支出列表。</p>
	{:else if $loading}
		<p>載入中…</p>
	{:else}
		<ul>
			{#each $items as e}
				<li>
					<strong>{e.title}</strong> — {e.amount}
					{e.currency} | {e.scope} | {e.is_settled ? '已結清' : '未結清'}
					<button on:click={() => toggle(e.id, !e.is_settled)}>
						{e.is_settled ? '標記為未結清' : '標記為已結清'}
					</button>
				</li>
			{/each}
		</ul>

		{#if $nextCursor}
			<button on:click={loadMore}>載入更多</button>
		{/if}
	{/if}
</div>

<style>
	.controls {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
		align-items: center;
	}
</style>
