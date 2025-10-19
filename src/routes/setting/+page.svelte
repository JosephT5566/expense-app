<script>
	import { goto } from '$app/navigation';
	import Icon from '@iconify/svelte';
	import { resolve } from '$app/paths';
</script>

<section class="card p-4 mb-[10vh] flex flex-col gap-3">
	<button
		class="px-3 py-1 btn-primary rounded-md border border-black/10"
		onclick={() => goto(resolve('/settle'))}
	>
		<Icon icon="" />
		Settle
	</button>
</section>
