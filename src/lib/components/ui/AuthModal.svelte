<script lang="ts">
	import { signIn } from '$lib/supabase/auth';
	import { user, loading } from '$lib/stores/session.store';
	import { Dialog } from 'bits-ui';
	import classNames from 'classnames';
	import { onDestroy } from 'svelte';
	import Icon from '@iconify/svelte';
	
	let open = $state(false);

	const unsubscribe = loading.subscribe(($loading) => {
		console.log('AuthModal loading changed:', $loading, $user);
		if ($loading) {
			open = true;
		} else {
			open = !$user; // close if user exists
		}
	});

	const unsubscribeUser = user.subscribe(($user) => {
		console.log('AuthModal user changed:', $user);
		if (!$user) {
			open = true;
		}
	});

	onDestroy(() => {
		unsubscribe();
		unsubscribeUser();
	});

	async function signInWithGoogle() {
		await signIn();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 bg-black/40" />
		{#if $loading}
			<Dialog.Content
				class={classNames(
					'card',
					'fixed',
					'left-[50%]',
					'top-[50%]',
					'translate-x-[-50%]',
					'translate-y-[-50%]',
					'p-5'
				)}
			>
				<Icon
					icon="svg-spinners:90-ring-with-bg"
					class="text-[var(--c-primary)]"
					width="24"
					height="24"
				/>
			</Dialog.Content>
		{:else}
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
					<button
						class="btn btn-primary flex items-center justify-center gap-3"
						onclick={signInWithGoogle}
					>
						<Icon icon="logos:google-icon" width="24px" height="24px" />
						<span>Continue with Google</span>
					</button>
				</div>
			</Dialog.Content>
		{/if}
	</Dialog.Portal>
</Dialog.Root>

<style>
	/* Disable ESC close: bits-ui doesn't close unless open=false; we never set it false until user exists */
</style>
