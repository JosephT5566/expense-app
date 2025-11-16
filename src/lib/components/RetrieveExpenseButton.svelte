<script lang="ts">
	import Icon from '@iconify/svelte';
	import classNames from 'classnames';
	import Logger from '$lib/utils/logger';
	import { forceRefetchMonthlyExpenses } from '$lib/data/expenses.fetcher';

	type Props = {
		monthKey: string;
		className?: string;
	};

	let { monthKey, className }: Props = $props();
	let isLoading = $state(false);

	async function handleRefresh() {
		isLoading = true;

		Logger.log('Refresh expenses for monthKey:', monthKey);
		await forceRefetchMonthlyExpenses(monthKey, 2000);

		isLoading = false;
	}
</script>

<button
	class={classNames(className, 'p-1', { 'opacity-50 animate-spin': isLoading })}
	onclick={() => {
		handleRefresh();
	}}
	disabled={isLoading}
>
	<Icon icon="solar:restart-bold" width="20" height="20" />
</button>
