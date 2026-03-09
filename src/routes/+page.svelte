<script lang="ts">
	import type { NoSignature, OrderContainer, Signature, StandardOrder } from "@lifi/intent";
	import { coinList } from "$lib/config";
	import { onDestroy } from "svelte";
	import Introduction from "$lib/components/Introduction.svelte";
	import { IntentApi } from "@lifi/intent";
	import ManageDeposit from "$lib/screens/ManageDeposit.svelte";
	import IssueIntent from "$lib/screens/IssueIntent.svelte";
	import IntentList from "$lib/screens/IntentList.svelte";
	import FillIntent from "$lib/screens/FillIntent.svelte";
	import ReceiveMessage from "$lib/screens/ReceiveMessage.svelte";
	import Finalise from "$lib/screens/Finalise.svelte";
	import ConnectWallet from "$lib/screens/ConnectWallet.svelte";
	import FlowStepTracker from "$lib/components/ui/FlowStepTracker.svelte";
	import store from "$lib/state.svelte";
	import { orderToIntent } from "@lifi/intent";

	// Fix bigint so we can json serialize it:
	(BigInt.prototype as any).toJSON = function () {
		return this.toString();
	};

	type OrderPackage = {
		order: StandardOrder;
		inputSettler: `0x${string}`;
		sponsorSignature?: `0x${string}`;
		allocatorSignature?: `0x${string}`;
	};

	$effect(() => {
		store.mainnet;
		store.inputTokens = [{ token: coinList(store.mainnet)[0], amount: 0n }];
		store.outputTokens = [{ token: coinList(store.mainnet)[1], amount: 0n }];
	});

	const intentApi = $derived(new IntentApi(store.mainnet));

	let disconnectWs: (() => void) | undefined;

	async function initiatePage() {
		if (disconnectWs) disconnectWs();

		// Wait for DB to finish loading so WS orders don't race with DB load
		await store.dbReady;

		// Connect to websocket server
		const connection = intentApi.connectIntentApiSocket((order: OrderPackage) => {
			try {
				const allocatorSignature = order.allocatorSignature
					? ({
							type: "ECDSA",
							payload: order.allocatorSignature
						} as Signature)
					: ({
							type: "None",
							payload: "0x"
						} as NoSignature);
				const sponsorSignature = order.sponsorSignature
					? ({
							type: "ECDSA",
							payload: order.sponsorSignature
						} as Signature)
					: ({
							type: "None",
							payload: "0x"
						} as NoSignature);
				const orderContainer = { ...order, allocatorSignature, sponsorSignature };

				// Deduplicate: only add if not already present
				const orderId = orderToIntent(orderContainer).orderId();
				const alreadyExists = store.orders.some((o) => orderToIntent(o).orderId() === orderId);
				if (alreadyExists) return;

				store.orders.push(orderContainer);
				store.saveOrderToDb(orderContainer).catch((e) => console.warn("saveOrderToDb error", e));
				console.log({ orders: store.orders, order });
			} catch (error) {
				console.error(error);
			}
		});
		disconnectWs = connection.disconnect;
	}

	$effect(() => {
		store.mainnet;
		initiatePage();
	});

	onDestroy(() => {
		if (disconnectWs) disconnectWs();
	});

	// --- Execute Transaction Variables --- //
	const preHook = (chainId: number) => store.setWalletToCorrectChain(chainId);
	const postHook = async () => store.forceUpdate();
	const account = () => store.connectedAccount?.address!;

	let selectedOrder = $state<OrderContainer | undefined>(undefined);
	let currentScreenIndex = $state(0);
	let scrollStepProgress = $state(0);
	async function importOrderById(orderId: `0x${string}`): Promise<"inserted" | "updated"> {
		const importedOrder = await intentApi.getOrderByOnChainOrderId(orderId);
		const importedOrderId = orderToIntent(importedOrder).orderId();
		const existingIndex = store.orders.findIndex(
			(o) => orderToIntent(o).orderId() === importedOrderId
		);
		await store.saveOrderToDb(importedOrder);
		selectedOrder =
			store.orders.find((o) => orderToIntent(o).orderId() === importedOrderId) ?? importedOrder;
		return existingIndex >= 0 ? "updated" : "inserted";
	}
	async function deleteOrderById(orderId: `0x${string}`): Promise<void> {
		await store.deleteOrderFromDb(orderId);
		if (selectedOrder && orderToIntent(selectedOrder).orderId() === orderId) {
			selectedOrder = undefined;
		}
	}

	let snapContainer: HTMLDivElement;

	function getScreenWidth() {
		if (!snapContainer) return 0;
		return snapContainer.clientWidth + 1;
	}

	function getMaxScreenIndex() {
		if (!snapContainer) return 0;
		const width = getScreenWidth();
		return Math.max(Math.ceil(snapContainer.scrollWidth / width) - 1, 0);
	}

	function updateCurrentScreenIndex() {
		if (!snapContainer) return;
		const width = getScreenWidth();
		const maxScreenIndex = getMaxScreenIndex();
		const rawIndex = snapContainer.scrollLeft / width;
		scrollStepProgress = Math.max(0, Math.min(rawIndex, maxScreenIndex));
		currentScreenIndex = Math.round(scrollStepProgress);
	}

	function goToScreen(index: number) {
		if (!snapContainer) return;
		const width = getScreenWidth();
		const maxScreenIndex = getMaxScreenIndex();
		const targetScreenIndex = Math.max(0, Math.min(index, maxScreenIndex));
		currentScreenIndex = targetScreenIndex;
		scrollStepProgress = targetScreenIndex;
		snapContainer.scrollTo({
			left: targetScreenIndex * width,
			behavior: "smooth"
		});
	}

	function scroll(next: boolean | number) {
		return () => {
			if (!snapContainer) return;
			updateCurrentScreenIndex();
			const maxScreenIndex = getMaxScreenIndex();
			const targetScreenIndex =
				typeof next === "number"
					? Math.max(0, Math.min(next, maxScreenIndex))
					: Math.max(0, Math.min(currentScreenIndex + (next ? 1 : -1), maxScreenIndex));
			goToScreen(targetScreenIndex);
		};
	}
</script>

<main class="main">
	<h1 class="mb-1 pt-3 text-center align-middle text-xl font-medium text-gray-900">
		Resource lock intents using OIF
	</h1>
	<div
		class="mx-auto flex flex-col-reverse items-center px-4 pt-2 md:max-w-[80rem] md:flex-row md:items-start md:px-10 md:pt-3"
	>
		<Introduction />
		<div
			class="mb-4 flex h-auto w-full flex-col items-stretch gap-2 md:mb-0 md:h-[30rem] md:w-max md:flex-row"
		>
			<div class="relative h-[30rem] w-full md:w-[25rem]">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="h-[30rem] w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden rounded-md border border-gray-200 bg-gray-50 md:w-[25rem]"
					bind:this={snapContainer}
					onscroll={updateCurrentScreenIndex}
				>
					<!-- Right Button -->
					<a
						class="absolute bottom-2 left-[18.5rem] w-40 cursor-pointer rounded px-1 text-xs hover:text-sky-800"
						href="https://li.fi"
					>
						Preview by LI.FI
					</a>

					{#if !(!store.connectedAccount || !store.walletClient)}
						<!-- Right Button -->
						<button
							class="absolute top-1.5 right-2 z-50 cursor-pointer rounded bg-sky-50 px-1"
							onclick={scroll(true)}
						>
							→
						</button>
						<!-- Back Button -->
						<button
							class="absolute top-1.5 left-[1rem] z-50 cursor-pointer rounded bg-sky-50 px-1"
							onclick={scroll(false)}
						>
							←
						</button>
					{/if}
					<div class="flex h-full w-max flex-row">
						{#if !store.connectedAccount || !store.walletClient}
							<ConnectWallet></ConnectWallet>
						{:else}
							<ManageDeposit {scroll} {preHook} {postHook} {account}></ManageDeposit>
							<IssueIntent {scroll} {preHook} {postHook} {account}></IssueIntent>
							<IntentList
								{scroll}
								bind:selectedOrder
								orderContainers={store.orders}
								onImportOrder={importOrderById}
								onDeleteOrder={deleteOrderById}
							></IntentList>
							{#if selectedOrder !== undefined}
								<!-- <IntentDescription></IntentDescription> -->
								<FillIntent {scroll} orderContainer={selectedOrder} {account} {preHook} {postHook}
								></FillIntent>
								<ReceiveMessage
									{scroll}
									orderContainer={selectedOrder}
									{account}
									{preHook}
									{postHook}
								></ReceiveMessage>
								<Finalise orderContainer={selectedOrder} {preHook} {postHook} {account}></Finalise>
							{/if}
						{/if}
					</div>
				</div>
			</div>
			<FlowStepTracker
				className="h-auto w-full md:h-full md:w-[6.25rem] flex-shrink-0"
				{currentScreenIndex}
				{scrollStepProgress}
				{selectedOrder}
				onStepClick={(step) => {
					if (step.targetIndex === undefined) return;
					goToScreen(step.targetIndex);
				}}
			/>
		</div>
	</div>
	<!-- Make a table to display orders from users -->
	<!-- <IntentTable {orders} walletClient={walletClient!} bind:opts={swapState} {updatedDerived} /> -->
</main>
