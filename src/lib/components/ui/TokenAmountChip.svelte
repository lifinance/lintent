<script lang="ts">
	let {
		amountText,
		symbol,
		tone = "neutral",
		interactive = false,
		className = ""
	}: {
		amountText: string;
		symbol: string;
		tone?: "neutral" | "success" | "warning" | "muted";
		interactive?: boolean;
		className?: string;
	} = $props();

	const toneClass = $derived.by(() => {
		if (tone === "success") return "border-emerald-200 bg-emerald-100 text-emerald-900";
		if (tone === "warning") return "border-amber-200 bg-amber-100 text-amber-900";
		if (tone === "muted") return "border-gray-200 bg-gray-100 text-gray-500";
		return "border-gray-200 bg-white text-gray-700";
	});
</script>

<div
	class={[
		"inline-flex h-8 items-center gap-1 rounded border px-2 text-xs font-medium whitespace-nowrap",
		toneClass,
		interactive ? "cursor-pointer hover:border-sky-300" : "",
		className
	]}
>
	<span>{amountText}</span>
	<span class="font-semibold text-gray-600">{symbol.toUpperCase()}</span>
</div>
