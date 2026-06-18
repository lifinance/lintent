<script lang="ts">
	import type { TimedIntentRow } from "$lib/libraries/intentList";
	import { copyToClipboard } from "$lib/utils/clipboard";

	let {
		row,
		rightBadge,
		rightText
	}: {
		row: TimedIntentRow;
		rightBadge: string;
		rightText: string;
	} = $props();

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function handleCopyOrderId(event: Event) {
		// Don't let the click select / toggle the parent card button.
		event.stopPropagation();
		if (!(await copyToClipboard(row.orderId))) return;
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1200);
	}

	function handleCopyKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			handleCopyOrderId(event);
		}
	}
</script>

<div class="flex items-start justify-between gap-2">
	<div class="min-w-0">
		<div class="flex min-w-0 flex-wrap items-center gap-1">
			<span class="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">IN</span
			>
			{#each row.inputChips as chip (chip.key)}
				<span class="truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px]" title={chip.text}
					>{chip.text}</span
				>
			{/each}
			{#if row.inputOverflow > 0}
				<span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px]">+{row.inputOverflow}</span>
			{/if}
			<span class="px-0.5 text-[10px] text-gray-500">→</span>
		</div>
		<div class="mt-1 flex min-w-0 flex-wrap items-center gap-1">
			<span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
				>OUT</span
			>
			{#each row.outputChips as chip (chip.key)}
				<span class="truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px]" title={chip.text}
					>{chip.text}</span
				>
			{/each}
			{#if row.outputOverflow > 0}
				<span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px]">+{row.outputOverflow}</span>
			{/if}
		</div>
	</div>
	<div class="flex flex-shrink-0 items-center gap-1">
		<span class="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700"
			>{rightBadge}</span
		>
		<span class="text-[10px] text-gray-500">{rightText}</span>
	</div>
</div>
<div class="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-gray-600">
	<span class="rounded bg-violet-100 px-1.5 py-0.5 text-violet-800">{row.chainScopeBadge}</span>
	{#if row.inputSchemeBadge}
		<span class="rounded bg-gray-100 px-1.5 py-0.5">{row.inputSchemeBadge}</span>
	{/if}
	{#each row.protocolBadges as badge (badge)}
		<span class="rounded bg-gray-100 px-1.5 py-0.5">{badge}</span>
	{/each}
	<span
		role="button"
		tabindex="0"
		class="cursor-pointer rounded px-1.5 py-0.5 transition-colors"
		class:bg-gray-100={!copied}
		class:hover:bg-gray-200={!copied}
		class:bg-emerald-100={copied}
		class:text-emerald-800={copied}
		style="-webkit-tap-highlight-color: transparent;"
		title={copied ? "Copied!" : `Copy full order id (${row.orderId})`}
		aria-label={copied ? "Order id copied" : `Copy full order id ${row.orderId}`}
		data-testid="intent-copy-order-id"
		onclick={handleCopyOrderId}
		onkeydown={handleCopyKeydown}>{copied ? "Copied!" : `Order ${row.orderIdShort}`}</span
	>
	<span class="rounded bg-gray-100 px-1.5 py-0.5">User {row.userShort}</span>
	<span class="rounded bg-gray-100 px-1.5 py-0.5"
		>{row.inputCount} inputs • {row.outputCount} outputs</span
	>
	<span
		class="rounded px-1.5 py-0.5"
		class:bg-emerald-100={row.validationPassed}
		class:text-emerald-800={row.validationPassed}
		class:bg-rose-100={!row.validationPassed}
		class:text-rose-800={!row.validationPassed}
		title={row.validationReason}
	>
		{row.validationPassed ? "Validation Pass" : `Invalid: ${row.validationReason}`}
	</span>
</div>
