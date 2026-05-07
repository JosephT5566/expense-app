<script lang="ts">
	import { Calendar as CalendarIcon } from "lucide-svelte";
	import { DateFormatter, getLocalTimeZone, type DateValue } from "@internationalized/date";
	import { RangeCalendar } from "$lib/components/shadcn/range-calendar";
	import * as Popover from "$lib/components/shadcn/popover";
	import { Button } from "$lib/components/shadcn/button";
	import { cn } from "$lib/utils";
	import { Label } from "$lib/components/shadcn/label";
	// import type { DateRange } from '@internationalized/date';

	type Props = {
		title?: string;
		value?: { start: DateValue | undefined; end: DateValue | undefined };
	};
	let { title, value = $bindable() }: Props = $props();

	let open = $state(false);

	const formatter = new DateFormatter("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

	function getDisplayDate() {
		if (value?.start && value?.end) {
			return `${formatter.format(value.start.toDate(getLocalTimeZone()))} - ${formatter.format(
				value.end.toDate(getLocalTimeZone())
			)}`;
		}
		if (value?.start) {
			return formatter.format(value.start.toDate(getLocalTimeZone()));
		}
		return "Pick a date range";
	}
</script>

<div class="grid gap-2">
	<Label for="date-range-picker" class="block select-none text-sm font-medium">{title}</Label>
	<Popover.Root bind:open>
		<Popover.Trigger>
			<Button
				id="date-range-picker"
				variant="outline"
				class={cn(
					"w-full justify-start text-left font-normal",
					!value?.start && "text-muted-foreground"
				)}
			>
				<CalendarIcon class="mr-2 h-4 w-4" />
				{getDisplayDate()}
			</Button>
		</Popover.Trigger>
		<Popover.Content class="w-auto p-0" align="start">
			<RangeCalendar
				bind:value
				numberOfMonths={2}
				onValueChange={() => {
					// Optionally close the popover when a range is selected
					if (value?.start && value?.end) {
						open = false;
					}
				}}
			/>
		</Popover.Content>
	</Popover.Root>
</div>
