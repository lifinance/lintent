<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		name,
		awaiting,
		buttonFunction,
		size = "md",
		variant = "default",
		fullWidth = false,
		baseClass = [],
		hoverClass = [],
		lazyClass = []
	}: {
		name: Snippet;
		awaiting: Snippet;
		buttonFunction: () => Promise<unknown>;
		size?: "sm" | "md";
		variant?: "default" | "success" | "warning" | "muted";
		fullWidth?: boolean;
		baseClass?: string[];
		hoverClass?: string[];
		lazyClass?: string[];
	} = $props();
	const sizeClass = $derived(size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm");
	const variantBaseClass = $derived.by(() => {
		if (variant === "success") return "border-emerald-200 bg-emerald-50 text-emerald-900";
		if (variant === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
		if (variant === "muted") return "border-gray-200 bg-gray-100 text-gray-500";
		return "border-gray-200 bg-white text-gray-700";
	});
	const variantHoverClass = $derived.by(() => {
		if (variant === "success") return "hover:border-emerald-300 hover:bg-emerald-100";
		if (variant === "warning") return "hover:border-amber-300 hover:bg-amber-100";
		if (variant === "muted") return "";
		return "hover:border-sky-300 hover:text-sky-700";
	});
	const defaultBase = $derived([
		sizeClass,
		"rounded border font-semibold",
		variantBaseClass,
		fullWidth ? "w-full" : ""
	]);
	const defaultHover = $derived(variantHoverClass ? [variantHoverClass] : []);
	const defaultLazy = [
		"cursor-not-allowed",
		variant === "muted" ? "text-gray-500" : "text-gray-400"
	];
	let buttonPromise: Promise<unknown> | undefined = $state();
	const run = () => {
		buttonPromise = buttonFunction().catch((error) => {
			console.error("AwaitButton action failed", error);
			throw error;
		});
	};
</script>

{#await buttonPromise}
	<button
		type="button"
		class={[...defaultBase, ...baseClass, ...defaultLazy, ...lazyClass]}
		disabled
	>
		{@render awaiting()}
	</button>
{:then}
	<button
		onclick={run}
		type="button"
		class={[...defaultBase, ...baseClass, ...defaultHover, ...hoverClass]}
	>
		{@render name()}
	</button>
{:catch}
	<button
		onclick={run}
		type="button"
		class={[...defaultBase, ...baseClass, ...defaultHover, ...hoverClass]}
	>
		{@render name()}
	</button>
{/await}
