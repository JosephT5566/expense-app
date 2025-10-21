<script lang="ts">
	import { DateRangePicker, type DateRange } from 'bits-ui';
	import Icon from '@iconify/svelte';
	import classNames from 'classnames';
	import { today, getLocalTimeZone } from '@internationalized/date';
	// import type { DateRange } from '@internationalized/date';

	type Props = {
		title?: string;
		dateRange?: DateRange;
	};
	let { title, dateRange = $bindable() }: Props = $props();

	let isOpen = $state(false);
</script>

<DateRangePicker.Root
	bind:value={dateRange}
	bind:open={isOpen}
	weekdayFormat="short"
	fixedWeeks={true}
	class="flex w-full max-w-[340px] flex-col gap-1.5"
	maxValue={today(getLocalTimeZone())}
>
	<DateRangePicker.Label class="block select-none text-sm font-medium"
		>{title}</DateRangePicker.Label
	>
	<div
		class="rounded-xl border-[var(--c-primary)]/50 bg-background text-[var(--c-text)] focus-within:border-[var(--c-primary)] focus-within:shadow-date-field-focus hover:border-[var(--c-primary)] flex w-full select-none items-center border p-2 text-sm tracking-[0.01em]"
	>
		{#each ['start', 'end'] as const as type (type)}
			<DateRangePicker.Input
				{type}
				onclick={() => {
					isOpen = true;
				}}
			>
				{#snippet children({ segments })}
					{#each segments as { part, value }, i (part + i)}
						<div class="inline-block select-none">
							{#if part === 'literal'}
								<DateRangePicker.Segment {part} class="text-[var(--c-accent)] p-1">
									{value}
								</DateRangePicker.Segment>
							{:else}
								<DateRangePicker.Segment
									{part}
									class="rounded-md hover:bg-[var(--c-bg)] focus:bg-[var(--c-bg)] focus:text-[var(--c-text)] aria-[valuetext=Empty]:text-[var(--c-muted)] focus-visible:outline-0! focus-visible:outline-offset-0! p-1"
								>
									{value}
								</DateRangePicker.Segment>
							{/if}
						</div>
					{/each}
				{/snippet}
			</DateRangePicker.Input>
			{#if type === 'start'}
				<div aria-hidden="true" class="text-[var(--c-accent)] px-1">–⁠⁠⁠⁠⁠</div>
			{/if}
		{/each}

		<DateRangePicker.Trigger
			class="text-[var(--c-primary)] data-[state=open]:bg-[var(--c-bg)] ml-auto inline-flex size-8 items-center justify-center rounded-[5px] transition-all"
		>
			<Icon icon="solar:calendar-bold-duotone" width="24" height="24" />
		</DateRangePicker.Trigger>
	</div>
	<DateRangePicker.Content
		sideOffset={6}
		onCloseAutoFocus={() => {
			if (!dateRange?.start || !dateRange?.end) {
				setTimeout(() => {
					dateRange = undefined;
				}, 10);
			}
		}}
		class="z-50"
	>
		<DateRangePicker.Calendar class="card bg-white shadow-md mt-6 p-[22px]">
			{#snippet children({ months, weekdays })}
				<DateRangePicker.Header class="flex items-center justify-between">
					<DateRangePicker.PrevButton
						class="rounded-xl bg-white hover:bg-[var(--c-bg)] inline-flex size-10 items-center justify-center transition-all active:scale-[0.98]"
						><Icon icon="solar:arrow-left-bold" width="24" height="24" />
					</DateRangePicker.PrevButton>
					<DateRangePicker.Heading class="text-[15px] font-medium" />
					<DateRangePicker.NextButton
						class="rounded-xl bg-white hover:bg-[var(--c-bg)] inline-flex size-10 items-center justify-center transition-all active:scale-[0.98]"
					>
						<Icon icon="solar:arrow-right-bold" width="24" height="24" />
					</DateRangePicker.NextButton>
				</DateRangePicker.Header>
				<div class="flex flex-col space-y-4 pt-4 sm:flex-row sm:space-x-4 sm:space-y-0">
					{#each months as month (month.value)}
						<DateRangePicker.Grid class="w-full border-collapse select-none space-y-1">
							<DateRangePicker.GridHead>
								<DateRangePicker.GridRow class="mb-1 flex w-full justify-between">
									{#each weekdays as day (day)}
										<DateRangePicker.HeadCell
											class="text-[var(--c-primary)] font-normal! w-10 rounded-md text-xs"
										>
											<div>{day.slice(0, 2)}</div>
										</DateRangePicker.HeadCell>
									{/each}
								</DateRangePicker.GridRow>
							</DateRangePicker.GridHead>
							<DateRangePicker.GridBody>
								{#each month.weeks as weekDates (weekDates)}
									<DateRangePicker.GridRow class="flex w-full">
										{#each weekDates as date (date)}
											<DateRangePicker.Cell
												{date}
												month={month.value}
												class="p-0! relative m-0 size-10 overflow-visible text-center text-sm focus-within:relative focus-within:z-20"
											>
												<DateRangePicker.Day
													class={classNames(
														'rounded-xl hover:border-[var(--c-primary)] focus-visible:outline-[var(--c-accent)]!',
														'data-selection-end:rounded-xl data-selection-start:rounded-xl',
														'data-highlighted:bg-[var(--c-bg)] data-selected:bg-[var(--c-bg)]',
														'data-disabled:text-[var(--c-text)]/30 data-selected:text-[var(--c-text)]',
														'data-selection-end:text-[var(--c-bg)] data-selection-start:text-[var(--c-bg)] data-selection-end:bg-[var(--c-primary)] data-selection-start:bg-[var(--c-primary)]',
														'data-selection-start:font-medium data-selection-start:focus-visible:outline-2 data-selection-start:focus-visible:outline-offset-2!',
														'data-selected:[&:not([data-selection-start])]:[&:not([data-selection-end])]:rounded-none data-selected:[&:not([data-selection-start])]:[&:not([data-selection-end])]:focus-visible:outline-0! data-selected:[&:not([data-selection-start])]:[&:not([data-selection-end])]:focus-visible:outline-offset-0!',
														'data-unavailable:text-[var(--c-muted)] data-selected:[&:not([data-selection-start])]:[&:not([data-selection-end])]:focus-visible:border-[var(--c-primary)] data-disabled:pointer-events-none data-highlighted:rounded-none  data-outside-month:pointer-events-none data-selected:font-medium data-selection-end:font-medium data-unavailable:line-through',
														'group relative inline-flex size-10 items-center justify-center overflow-visible whitespace-nowrap border border-transparent bg-transparent p-0 text-sm font-normal transition-all'
													)}
												>
													<div
														class="bg-[var(--c-primary)] group-data-selected:bg-[var(--c-bg)] group-data-today:block absolute top-[5px] hidden size-1 rounded-full transition-all"
													></div>
													{date.day}
												</DateRangePicker.Day>
											</DateRangePicker.Cell>
										{/each}
									</DateRangePicker.GridRow>
								{/each}
							</DateRangePicker.GridBody>
						</DateRangePicker.Grid>
					{/each}
				</div>
			{/snippet}
		</DateRangePicker.Calendar>
	</DateRangePicker.Content>
</DateRangePicker.Root>
