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
	<section class="card p-4">
		<h2 class="font-semibold mb-2">Add</h2>
		<p class="opacity-70">（之後放新增開銷表單；現在先做殼）</p>
	</section>
</div>

<style>
	.controls {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
		align-items: center;
	}
</style>
