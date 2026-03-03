<script lang="ts">
	let {
		value = $bindable(),
		metaText,
		metaPrefix = "of",
		disabled = false
	}: {
		value: number | null;
		metaText: string;
		metaPrefix?: string;
		disabled?: boolean;
	} = $props();
</script>

<div class="flex h-7 min-w-0 items-center rounded border border-gray-200 bg-white px-2 text-sm">
	<input
		type="number"
		class="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none disabled:cursor-not-allowed disabled:text-gray-400"
		defaultValue="0"
		bind:value
		{disabled}
	/>
	<div class="ml-2 min-w-0 truncate text-[11px] whitespace-nowrap text-gray-500">
		{metaPrefix}
		{metaText}
	</div>
</div>
