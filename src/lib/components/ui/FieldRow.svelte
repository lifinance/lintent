<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		columns,
		header = false,
		striped = false,
		index = 0,
		className = "",
		children
	}: {
		columns: string;
		header?: boolean;
		striped?: boolean;
		index?: number;
		className?: string;
		children?: Snippet;
	} = $props();
</script>

<div
	class={[
		"grid gap-2",
		header
			? "border-b border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-500"
			: "items-center px-2 py-1.5",
		striped && index % 2 === 1 ? "bg-gray-50" : "",
		className
	]}
	style={`grid-template-columns: ${columns};`}
>
	{@render children?.()}
</div>
