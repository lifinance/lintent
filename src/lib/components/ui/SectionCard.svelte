<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		headerRight,
		compact = false,
		className = "",
		children
	}: {
		title?: string;
		headerRight?: Snippet;
		compact?: boolean;
		className?: string;
		children?: Snippet;
	} = $props();
</script>

<div class={["rounded border border-gray-200 bg-white", className]}>
	{#if title || headerRight}
		<div
			class={[
				"flex items-center justify-between border-b border-gray-200",
				compact ? "px-2 py-1" : "px-3 py-2"
			]}
		>
			{#if title}
				<h3 class="text-xs font-semibold tracking-wide text-gray-500 uppercase">{title}</h3>
			{/if}
			{#if headerRight}
				<div>
					{@render headerRight()}
				</div>
			{/if}
		</div>
	{/if}
	<div class={compact ? "p-2" : "p-3"}>
		{@render children?.()}
	</div>
</div>
