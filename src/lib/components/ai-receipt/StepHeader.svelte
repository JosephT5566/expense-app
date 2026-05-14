<script lang="ts">
	import * as Dialog from '$lib/components/shadcn/dialog';
	import { Button } from '$lib/components/shadcn/button';
	import { ChevronLeft, Check } from 'lucide-svelte';
	import type { ComponentType } from 'svelte';

	interface Step {
		id: number;
		title: string;
		icon: ComponentType;
	}

	let {
		aiStep,
		wizardSteps,
		aiUploading,
		aiAnalyzing,
		onBack
	}: {
		aiStep: number;
		wizardSteps: Step[];
		aiUploading: boolean;
		aiAnalyzing: boolean;
		onBack: () => void;
	} = $props();

	// Calculate progress percentage for the indicator line
	const progressWidth = $derived(`${((aiStep - 1) / (wizardSteps.length - 1)) * 100}%`);
</script>

<Dialog.Header class="space-y-6">
	<div class="flex items-center gap-4">
		{#if aiStep > 1}
			<Button
				variant="ghost"
				size="icon"
				class="h-8 w-8 -ml-1 rounded-full"
				onclick={onBack}
				disabled={aiUploading || aiAnalyzing}
			>
				<ChevronLeft class="h-5 w-5" />
			</Button>
		{/if}
		<Dialog.Title class="text-xl font-bold">AI 分析</Dialog.Title>
	</div>

	<div class="relative px-4">
		<!-- Progress Line Background -->
		<div class="absolute left-10 right-10 top-5 h-0.5 bg-muted">
			<!-- Active Progress Line -->
			<div
				class="h-full bg-primary transition-all duration-300 ease-in-out"
				style:width={progressWidth}
			></div>
		</div>

		<div class="relative flex justify-between">
			{#each wizardSteps as step (step.id)}
				{@const isCompleted = aiStep > step.id}
				{@const isActive = aiStep === step.id}

				<div class="flex flex-col items-center">
					<div
						class="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all duration-300 {isCompleted
							? 'border-primary bg-primary text-primary-foreground'
							: isActive
								? 'border-primary bg-background text-primary shadow-sm'
								: 'border-muted bg-background text-muted-foreground'}"
					>
						{#if isCompleted}
							<Check class="h-5 w-5" strokeWidth={3} />
						{:else}
							<step.icon class="h-5 w-5" />
						{/if}
					</div>
					<span
						class="mt-3 text-[10px] font-bold uppercase tracking-widest transition-colors {isActive
							? 'text-primary'
							: isCompleted
								? 'text-foreground'
								: 'text-muted-foreground'}"
					>
						{step.title}
					</span>
				</div>
			{/each}
		</div>
	</div>
</Dialog.Header>
