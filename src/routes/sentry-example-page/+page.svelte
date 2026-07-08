<script lang="ts">
	function triggerError() {
		throw new Error('Sentry example page test error');
	}
</script>

<svelte:head>
	<title>Sentry Example | JoPie</title>
</svelte:head>

<section class="space-y-4">
	<div>
		<h1 class="text-2xl font-bold">Sentry Example</h1>
		<p class="text-sm opacity-70">Use this page to verify Sentry error reporting.</p>
	</div>

	<button class="btn btn-error" onclick={triggerError}>Trigger test error</button>
</section>
