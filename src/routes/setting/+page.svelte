<script>
	import Icon from '@iconify/svelte';
	import { resolve } from '$app/paths';
</script>

<section class="card p-4 mb-[10vh] flex flex-col gap-3">
	<a class="px-3 py-1 btn btn-primary-light rounded-md" href={resolve('/settle')}>
		<Icon icon="solar:hand-stars-bold-duotone" width="24" height="24" />
		分帳
	</a>
	<a class="px-3 py-1 btn btn-primary-light rounded-md" href={resolve('/search')}>
		<Icon icon="solar:card-search-bold-duotone" width="24" height="24" />
		搜尋
	</a>
</section>
