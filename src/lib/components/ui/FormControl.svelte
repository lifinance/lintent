<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		as = "input",
		value = $bindable(),
		type = "text",
		size = "md",
		density,
		state = "default",
		className = "",
		children,
		...rest
	}: {
		as?: "input" | "select";
		value?: string | number | null;
		type?: string;
		size?: "sm" | "md";
		density?: "sm" | "md";
		state?: "default" | "disabled" | "error";
		className?: string;
		children?: Snippet;
		[key: string]: unknown;
	} = $props();

	const effectiveSize = $derived(density ?? size);
	const sizeClass = $derived(effectiveSize === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2 text-sm");
	const stateClass = $derived.by(() => {
		if (state === "error") return "border-rose-300 text-rose-700";
		if (state === "disabled") return "cursor-not-allowed text-gray-400 bg-gray-50";
		return "border-gray-200 bg-white text-gray-700";
	});
</script>

{#if as === "select"}
	<select
		bind:value
		{...rest}
		class={[
			"min-w-0 rounded border transition-colors outline-none focus:border-sky-300",
			sizeClass,
			stateClass,
			className
		]}
	>
		{@render children?.()}
	</select>
{:else}
	<input
		bind:value
		{type}
		{...rest}
		class={[
			"min-w-0 rounded border transition-colors outline-none focus:border-sky-300",
			sizeClass,
			stateClass,
			className
		]}
	/>
{/if}
