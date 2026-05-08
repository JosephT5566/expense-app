<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";

	type $$Props = SelectPrimitive.ValueProps;

	let className: $$Props["class"] = undefined;
	export { className as class };
</script>

<SelectPrimitive.Value class={className} {...$$restProps} />
