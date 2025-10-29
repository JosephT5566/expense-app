<script lang="ts">
	import { signInWithOAuth } from '$lib/supabase/auth';
	import { user, loading } from '$lib/stores/session.store';
	import { Dialog } from 'bits-ui';
	import classNames from 'classnames';
	import { onDestroy } from 'svelte';
	import Icon from '@iconify/svelte';
	let open = $state(false);

	const unsubscribe = loading.subscribe(($loading) => {
		console.log('AuthModal user changed:', $loading, $user);
		if (!$loading) {
			open = !$user;
		}
	});

	onDestroy(() => {
		unsubscribe();
	});

	async function signInWithGoogle() {
		await signInWithOAuth({
			provider: 'google',
			options: { redirectTo: window.location.origin },
		});
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 bg-black/40" />
		<Dialog.Content
			class={classNames(
				'card',
				'fixed',
				'inset-x-4',
				'left-[50%]',
				'top-[50%]',
				'w-full',
				'max-w-[calc(100%-2rem)]',
				'translate-x-[-50%]',
				'translate-y-[-50%]',
				'p-5'
			)}
			escapeKeydownBehavior="ignore"
			interactOutsideBehavior="ignore"
		>
			<Dialog.Title class="text-lg font-semibold">Sign in</Dialog.Title>
			<Dialog.Description class="opacity-80 mb-4">請先登入</Dialog.Description>

			<div class="grid gap-2">
				<button class="btn btn-primary flex items-center justify-center gap-3" onclick={signInWithGoogle}>
                    <Icon icon="logos:google-icon" width="24px" height="24px" />
					<span>Continue with Google</span>
				</button>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	/* Disable ESC close: bits-ui doesn't close unless open=false; we never set it false until user exists */
</style>
