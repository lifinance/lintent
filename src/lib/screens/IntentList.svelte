<script lang="ts">
	import { onDestroy } from "svelte";
	import { tick } from "svelte";
	import { orderToIntent, isSolanaOriginOrder } from "@lifi/intent";
	import IntentListDetailRow from "$lib/components/IntentListDetailRow.svelte";
	import {
		buildBaseIntentRow,
		withTiming,
		formatRelativeDeadline,
		formatRemaining,
		type TimedIntentRow
	} from "$lib/libraries/intentList";
	import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
	import SectionCard from "$lib/components/ui/SectionCard.svelte";
	import type { OrderContainer } from "@lifi/intent";

	let {
		scroll,
		selectedOrder = $bindable(),
		orderContainers,
		onImportOrder,
		onDeleteOrder
	}: {
		scroll: (direction: boolean | number) => () => void;
		selectedOrder: OrderContainer | undefined;
		orderContainers: OrderContainer[];
		onImportOrder: (orderId: `0x${string}`) => Promise<"inserted" | "updated">;
		onDeleteOrder: (orderId: `0x${string}`) => Promise<void>;
	} = $props();

	let importOrderId = $state("");
	let importState = $state<"idle" | "loading" | "success" | "error">("idle");
	let importMessage = $state("");
	let deletingOrderId = $state<string | undefined>(undefined);

	async function handleImport() {
		const orderId = importOrderId.trim();
		if (!/^0x[a-fA-F0-9]{64}$/.test(orderId)) {
			importState = "error";
			importMessage = "Order id must be a 32-byte hash (0x + 64 hex chars).";
			return;
		}
		importState = "loading";
		importMessage = "Looking up order...";
		try {
			const result = await onImportOrder(orderId as `0x${string}`);
			importState = "success";
			importMessage = result === "updated" ? "Order updated in list." : "Order imported.";
			importOrderId = "";
		} catch (error) {
			importState = "error";
			importMessage = error instanceof Error ? error.message : "Failed to import order.";
		}
	}

	async function handleDelete(orderId: `0x${string}`) {
		deletingOrderId = orderId;
		try {
			await onDeleteOrder(orderId);
			if (importState !== "error") {
				importState = "idle";
				importMessage = "";
			}
		} catch (error) {
			importState = "error";
			importMessage = error instanceof Error ? error.message : "Failed to delete order.";
		} finally {
			deletingOrderId = undefined;
		}
	}

	function getActiveRightBadge(row: TimedIntentRow, selectedOrderId: string | undefined) {
		return selectedOrderId === row.orderId ? "Active" : "Expires";
	}

	function getActiveRightText(row: TimedIntentRow, selectedOrderId: string | undefined) {
		return selectedOrderId === row.orderId
			? `for ${formatRemaining(row.secondsToDeadline)}`
			: `in ${formatRemaining(row.secondsToDeadline)}`;
	}

	let nowSeconds = $state(Math.floor(Date.now() / 1000));
	let expandedExpiredOrderId = $state<string | undefined>(undefined);
	const clock = setInterval(() => {
		nowSeconds = Math.floor(Date.now() / 1000);
	}, 1000);
	onDestroy(() => clearInterval(clock));

	const baseRows = $derived(
		orderContainers
			.filter((oc) => !isSolanaOriginOrder(oc.order))
			.map((orderContainer) => buildBaseIntentRow(orderContainer))
	);
	const rows = $derived(baseRows.map((row) => withTiming(row, nowSeconds)));

	const activeRows = $derived(
		[...rows]
			.filter((row) => row.status !== "expired")
			.sort((a, b) => a.fillDeadline - b.fillDeadline)
	);

	const expiredRows = $derived(
		[...rows]
			.filter((row) => row.status === "expired")
			.sort((a, b) => b.fillDeadline - a.fillDeadline)
	);

	const selectedOrderId = $derived(
		selectedOrder && !isSolanaOriginOrder(selectedOrder.order)
			? orderToIntent(selectedOrder).orderId()
			: undefined
	);
</script>

<ScreenFrame
	title="Select Intent To Solve"
	description="Click any row to open it in the fill flow."
	bodyClass="mt-2 flex h-[22rem] flex-col overflow-y-auto align-middle pr-1"
>
	<div class="mb-2 flex items-center gap-2">
		<input
			class="h-8 min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 text-sm text-gray-700 outline-none focus:border-sky-300"
			type="text"
			placeholder="Order Id"
			bind:value={importOrderId}
			data-testid="intent-import-order-id"
			onkeydown={(event) => {
				if (event.key === "Enter") handleImport();
			}}
		/>
		<button
			type="button"
			class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 hover:border-sky-300 hover:text-sky-700 disabled:cursor-not-allowed disabled:text-gray-400"
			onclick={handleImport}
			disabled={importState === "loading"}
			data-testid="intent-import-order-submit"
		>
			{importState === "loading" ? "Importing..." : "Import"}
		</button>
	</div>
	{#if importMessage}
		<div
			class="mb-2 text-xs"
			class:text-rose-600={importState === "error"}
			class:text-emerald-700={importState === "success"}
			class:text-gray-500={importState === "loading" || importState === "idle"}
			aria-live="polite"
			data-testid="intent-import-order-status"
		>
			{importMessage}
		</div>
	{/if}
	<SectionCard title={`Active intents (${activeRows.length})`} className="mb-2" compact>
		<div class="space-y-2">
			{#each activeRows as row (row.orderId)}
				<div class="relative">
					<button
						class:border-amber-300={row.status === "expiring"}
						class:bg-amber-50={row.status === "expiring"}
						class="w-full cursor-pointer rounded border border-gray-200 bg-white px-2 py-2 text-left transition-shadow ease-linear select-none hover:shadow-md focus:outline-none focus-visible:outline-none"
						style="-webkit-tap-highlight-color: transparent;"
						onclick={async () => {
							selectedOrder = row.orderContainer;
							await tick();
							scroll(3)();
						}}
					>
						<IntentListDetailRow
							{row}
							rightBadge={getActiveRightBadge(row, selectedOrderId)}
							rightText={getActiveRightText(row, selectedOrderId)}
						/>
					</button>
					<button
						type="button"
						class="absolute right-2 bottom-2 rounded border border-rose-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:border-rose-300 disabled:cursor-not-allowed disabled:text-rose-300"
						onclick={() => handleDelete(row.orderId as `0x${string}`)}
						disabled={deletingOrderId === row.orderId}
						data-testid={`intent-delete-${row.orderId}`}
					>
						{deletingOrderId === row.orderId ? "..." : "Delete"}
					</button>
				</div>
			{/each}
		</div>
	</SectionCard>
	<SectionCard title={`Expired intents (${expiredRows.length})`} compact>
		<div class="space-y-1">
			{#each expiredRows as row (row.orderId)}
				<div class="relative rounded border border-gray-200 bg-gray-50">
					<button
						class="w-full cursor-pointer px-2 py-1.5 text-left text-xs text-gray-500 transition-colors select-none hover:bg-gray-100 focus:outline-none focus-visible:outline-none"
						style="-webkit-tap-highlight-color: transparent;"
						onclick={async () => {
							expandedExpiredOrderId =
								expandedExpiredOrderId === row.orderId ? undefined : row.orderId;
						}}
					>
						{#if expandedExpiredOrderId === row.orderId}
							<IntentListDetailRow
								{row}
								rightBadge="Expired"
								rightText={formatRelativeDeadline(row.secondsToDeadline)}
							/>
						{:else}
							<div class="flex items-center justify-between gap-2">
								<div class="min-w-0 truncate">
									{row.chainScope} • {row.inputCount} in → {row.outputCount} out • {row.orderIdShort}
								</div>
								<div class="flex-shrink-0">{formatRelativeDeadline(row.secondsToDeadline)}</div>
							</div>
						{/if}
					</button>
					{#if expandedExpiredOrderId === row.orderId}
						<button
							type="button"
							class="absolute right-2 bottom-1.5 rounded border border-rose-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:border-rose-300 disabled:cursor-not-allowed disabled:text-rose-300"
							onclick={() => handleDelete(row.orderId as `0x${string}`)}
							disabled={deletingOrderId === row.orderId}
							data-testid={`intent-delete-${row.orderId}`}
						>
							{deletingOrderId === row.orderId ? "..." : "Delete"}
						</button>
					{/if}
				</div>
			{/each}
		</div>
	</SectionCard>
</ScreenFrame>
