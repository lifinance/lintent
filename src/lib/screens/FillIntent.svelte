<script lang="ts">
	import { BYTES32_ZERO, formatTokenAmount, getChainName, getClient, getCoin } from "$lib/config";
	import { bytes32ToAddress } from "@lifi/intent";
	import { getOutputHash } from "@lifi/intent";
	import type { MandateOutput, OrderContainer } from "@lifi/intent";
	import { Solver } from "$lib/libraries/solver";
	import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
	import AwaitButton from "$lib/components/AwaitButton.svelte";
	import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
	import SectionCard from "$lib/components/ui/SectionCard.svelte";
	import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
	import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";
	import store from "$lib/state.svelte";
	import { orderToIntent } from "@lifi/intent";
	import { compactTypes } from "@lifi/intent";
	import { hashStruct } from "viem";

	let {
		scroll,
		orderContainer,
		account,
		preHook,
		postHook
	}: {
		scroll: (direction: boolean | number) => () => void;
		orderContainer: OrderContainer;
		preHook?: (chainId: number) => Promise<any>;
		postHook: () => Promise<any>;
		account: () => `0x${string}`;
	} = $props();

	let refreshValidation = $state(0);
	let autoScrolledOrderId = $state<`0x${string}` | null>(null);
	let fillRun = 0;
	let fillStatuses = $state<Record<string, `0x${string}`>>({});
	const postHookScroll = async () => {
		await postHook();
		refreshValidation += 1;
	};

	async function isFilled(orderId: `0x${string}`, output: MandateOutput, _?: any) {
		const outputHash = getOutputHash(output);
		const outputClient = getClient(output.chainId);
		const result = await outputClient.readContract({
			address: bytes32ToAddress(output.settler),
			abi: COIN_FILLER_ABI,
			functionName: "getFillRecord",
			args: [orderId, outputHash]
		});
		return result;
	}

	function sortOutputsByChain(orderContainer: OrderContainer) {
		const outputs = orderContainer.order.outputs;
		const positionMap: { [chainId: string]: number } = {};
		const arrMap: [bigint, MandateOutput[]][] = [];
		for (const output of outputs) {
			const chainId = output.chainId;
			// Check if chainId exists.
			let position = positionMap[chainId.toString()];
			if (position == undefined) {
				position = arrMap.length;
				positionMap[chainId.toString()] = position;
				arrMap.push([chainId, []]);
			}
			arrMap[position][1].push(output);
		}
		return arrMap;
	}
	const outputKey = (output: MandateOutput) =>
		hashStruct({
			data: output,
			types: compactTypes,
			primaryType: "MandateOutput"
		});

	$effect(() => {
		refreshValidation;

		const orderId = orderToIntent(orderContainer).orderId();
		if (autoScrolledOrderId === orderId) return;

		const outputs = sortOutputsByChain(orderContainer).flatMap(([, chainOutputs]) => chainOutputs);
		if (outputs.length === 0) return;

		const currentRun = ++fillRun;
		Promise.all(
			outputs.map(async (output) => [outputKey(output), await isFilled(orderId, output)] as const)
		)
			.then((entries) => {
				if (currentRun !== fillRun) return;
				const nextStatuses: Record<string, `0x${string}`> = {};
				for (const [key, status] of entries) nextStatuses[key] = status;
				fillStatuses = nextStatuses;
				if (!entries.every(([, result]) => result !== BYTES32_ZERO)) return;
				autoScrolledOrderId = orderId;
				scroll(4)();
			})
			.catch((e) => console.warn("auto-scroll fill check failed", e));
	});

	const fillWrapper = (outputs: MandateOutput[], func: ReturnType<typeof Solver.fill>) => {
		return async () => {
			const result = await func();

			for (const output of outputs) {
				const outputHash = hashStruct({
					data: output,
					types: compactTypes,
					primaryType: "MandateOutput"
				});
				store.fillTransactions[outputHash] = result;
				store
					.saveFillTransaction(outputHash, result)
					.catch((e) => console.warn("saveFillTransaction error", e));
			}
		};
	};
</script>

<ScreenFrame
	title="Fill Intent"
	description="Fill each chain once and continue to the right. If you refreshed the page provide your fill tx hash in the input box."
>
	<div class="space-y-2">
		{#each sortOutputsByChain(orderContainer) as chainIdAndOutputs}
			<SectionCard compact>
				<ChainActionRow chainLabel={getChainName(chainIdAndOutputs[0])}>
					{#snippet action()}
						{@const chainStatuses = chainIdAndOutputs[1].map(
							(output) => fillStatuses[outputKey(output)]
						)}
						{#if chainStatuses.some((status) => status === undefined)}
							<button
								type="button"
								class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
								disabled
							>
								Fill
							</button>
						{:else}
							<AwaitButton
								variant={chainStatuses.every((v) => v == BYTES32_ZERO) ? "default" : "muted"}
								buttonFunction={chainStatuses.every((v) => v == BYTES32_ZERO)
									? fillWrapper(
											chainIdAndOutputs[1],
											Solver.fill(
												store.walletClient,
												{
													orderContainer,
													outputs: chainIdAndOutputs[1]
												},
												{
													preHook,
													postHook: postHookScroll,
													account
												}
											)
										)
									: async () => {}}
							>
								{#snippet name()}
									Fill
								{/snippet}
								{#snippet awaiting()}
									Waiting for transaction...
								{/snippet}
							</AwaitButton>
						{/if}
					{/snippet}
					{#snippet chips()}
						{#each chainIdAndOutputs[1] as output}
							{@const filled = fillStatuses[outputKey(output)]}
							<TokenAmountChip
								amountText={formatTokenAmount(
									output.amount,
									getCoin({
										address: output.token,
										chainId: output.chainId
									}).decimals
								)}
								symbol={getCoin({ address: output.token, chainId: output.chainId }).name}
								tone={filled === undefined
									? "muted"
									: filled === BYTES32_ZERO
										? "neutral"
										: "success"}
							/>
						{/each}
					{/snippet}
				</ChainActionRow>
			</SectionCard>
			<!-- <input
				class="w-20 rounded border px-2 py-1"
				placeholder="fillTransactionHash"
				bind:value={
					store.fillTransactions[
						hashStruct({
							data: { outputs: chainIdAndOutputs.outputs },
							types: {
								...compactTypes,
								Outputs
							},
							primaryType: "Outputs"
						})
					]
				}
			/> -->
		{/each}
	</div>
</ScreenFrame>
