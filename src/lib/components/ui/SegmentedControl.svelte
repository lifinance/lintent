<script lang="ts">
	type Option = {
		label: string;
		value: string;
	};

	let {
		options,
		value = $bindable(),
		onChange,
		testIdPrefix,
		size = "md"
	}: {
		options: Option[];
		value: string;
		onChange?: (value: string) => void;
		testIdPrefix?: string;
		size?: "sm" | "md";
	} = $props();

	const sizeClass = $derived(size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm");
</script>

<div class="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white">
	{#each options as option, i (option.value)}
		<button
			type="button"
			data-testid={testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined}
			class={[
				sizeClass,
				i > 0 ? "border-l border-gray-200" : "",
				"transition-colors",
				value === option.value
					? "bg-gray-100 font-semibold text-gray-800"
					: "bg-white text-gray-700 hover:bg-gray-50"
			]}
			onclick={() => {
				value = option.value;
				onChange?.(option.value);
			}}
		>
			{option.label}
		</button>
	{/each}
</div>
