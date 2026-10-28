<script lang="ts">
	import type { DraftField } from '@jopie/semantic-entry-contract';
	let { field }: { field: DraftField<unknown> } = $props();
	const labels = {
		recognized: '已辨識',
		unrecognized: '無法辨識',
		missing: '未提供',
		explicit_null: '明確為空'
	};
</script>

{#if field.source !== 'user'}<span class="rounded border px-1.5 py-0.5 text-xs font-normal"
		>{labels[field.state]}</span
	>{/if}
