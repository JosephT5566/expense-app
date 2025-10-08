<script lang="ts">
	import { activeTab, type Tab } from '$lib/stores/nav.store';
    import Icon from '@iconify/svelte';
	const items: { key: Tab; label: string; icon: string }[] = [
		{ key: 'add', label: 'Add', icon: 'solar:document-add-bold-duotone' },
		{ key: 'summary', label: 'Summary', icon: 'solar:graph-up-bold-duotone' },
		{ key: 'setting', label: 'Setting', icon: 'solar:settings-bold-duotone' },
	];
</script>

<nav class="fixed bottom-0 inset-x-0 safe-bottom bg-white border-t border-black/10 z-20">
	<ul class="grid grid-cols-3">
		{#each items as it (it.key)}
			<li>
				<button
					class="w-full py-3 text-sm flex flex-col items-center gap-1"
					class:selected={$activeTab === it.key}
					onclick={() => activeTab.set(it.key)}
				>
					<Icon
						icon={it.icon}
						width="24"
						height="24"
					/>
					<span>{it.label}</span>
				</button>
			</li>
		{/each}
	</ul>
</nav>

<style>
	button.selected {
		color: var(--c-primary);
		font-weight: 600;
	}
	nav {
		background: var(--c-card);
	}
</style>
