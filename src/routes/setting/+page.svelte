<script>
	import Icon from '@iconify/svelte/dist/OfflineIcon.svelte';
	import { resolve } from '$app/paths';
	import { signOut } from '$lib/supabase/auth';
	import { Button } from '$lib/components/shadcn/button';
</script>

<section class="card p-4 mb-[10vh] flex flex-col gap-3">
	<Button href={resolve('/settle')} variant="outline" class="justify-center gap-2">
		<Icon icon="ph:hand-heart-duotone" width="24" height="24" />
		分帳
	</Button>
	<Button href={resolve('/search')} variant="outline" class="justify-center gap-2">
		<Icon icon="ph:magnifying-glass-duotone" width="24" height="24" />
		搜尋
	</Button>
	<Button href={resolve('/scheduled')} variant="outline" class="justify-center gap-2">
		<Icon icon="ph:calendar-dots-duotone" width="24" height="24" />
		預定支出
	</Button>
	<Button onclick={signOut} variant="destructive" class="justify-center gap-2">
		<Icon icon="ph:sign-out-duotone" width="24" height="24" />
		登出
	</Button>
</section>
