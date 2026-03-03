<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		description,
		contentClass = "",
		bodyClass = "mt-2 h-[22rem] overflow-y-auto pr-1",
		children
	}: {
		title: string;
		description: string;
		contentClass?: string;
		bodyClass?: string;
		children?: Snippet;
	} = $props();
</script>

<div class={["h-[29rem] w-[25rem] flex-shrink-0 snap-center snap-always p-4", contentClass]}>
	{#if title}
		<h1 class="mb-1 w-full text-center text-2xl font-medium text-gray-900">{title}</h1>
	{/if}
	{#if description}
		<p class="mb-2 text-center text-xs leading-relaxed text-gray-500">{description}</p>
	{/if}
	<div class={bodyClass}>
		{@render children?.()}
	</div>
</div>
