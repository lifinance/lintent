<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		chainLabel,
		state = "idle",
		action,
		chips,
		className = ""
	}: {
		chainLabel: string;
		state?: "idle" | "pending" | "done" | "warning";
		action?: Snippet;
		chips?: Snippet;
		className?: string;
	} = $props();

	const stateClass = $derived.by(() => {
		if (state === "done") return "text-emerald-800";
		if (state === "warning") return "text-amber-800";
		if (state === "pending") return "text-sky-800";
		return "text-gray-700";
	});
</script>

<div class={["py-1", stateClass, className]}>
	<div class="mb-1 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
		{chainLabel}
	</div>
	<div class="flex items-center gap-2">
		<div class="flex-shrink-0">
			{@render action?.()}
		</div>
		<div class="min-w-0 flex-1 overflow-x-auto">
			<div class="flex min-w-max items-center gap-1.5">
				{@render chips?.()}
			</div>
		</div>
	</div>
</div>
