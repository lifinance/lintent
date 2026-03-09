<script lang="ts">
	import { formatTokenAmount, getChainName, getClient, getCoin } from "$lib/config";
	import { addressToBytes32 } from "@lifi/intent";
	import { encodeMandateOutput } from "@lifi/intent";
	import { hashStruct, keccak256 } from "viem";
	import type { MandateOutput, OrderContainer } from "@lifi/intent";
	import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
	import { Solver } from "$lib/libraries/solver";
	import AwaitButton from "$lib/components/AwaitButton.svelte";
	import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
	import SectionCard from "$lib/components/ui/SectionCard.svelte";
	import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
	import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";
	import store from "$lib/state.svelte";
	import { orderToIntent } from "@lifi/intent";
	import { compactTypes } from "@lifi/intent";

	// This script needs to be updated to be able to fetch the associated events of fills. Currently, this presents an issue since it can only fill single outputs.

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
	let validationRun = 0;
	let validationStatuses = $state<Record<string, boolean>>({});
	const postHookRefreshValidate = async () => {
		await postHook();
		refreshValidation += 1;
	};
	const outputKey = (output: MandateOutput) =>
		hashStruct({
			data: output,
			types: compactTypes,
			primaryType: "MandateOutput"
		});
	const validationKey = (inputChain: bigint, output: MandateOutput) =>
		`${inputChain.toString()}:${outputKey(output)}`;

	async function isValidated(
		orderId: `0x${string}`,
		chainId: bigint,
		orderContainer: OrderContainer,
		output: MandateOutput,
		fillTransactionHash: `0x${string}`,
		_?: any
	) {
		if (!fillTransactionHash) return false;
		if (
			!fillTransactionHash ||
			!fillTransactionHash.startsWith("0x") ||
			fillTransactionHash.length != 66
		)
			return false;
		const { order } = orderContainer;
		const outputClient = getClient(output.chainId);
		const transactionReceipt = await outputClient.getTransactionReceipt({
			hash: fillTransactionHash
		});
		const blockHashOfFill = transactionReceipt.blockHash;
		const block = await outputClient.getBlock({
			blockHash: blockHashOfFill
		});
		const encodedOutput = encodeMandateOutput({
			solver: addressToBytes32(transactionReceipt.from),
			orderId,
			timestamp: Number(block.timestamp),
			output
		});
		const outputHash = keccak256(encodedOutput);
		const sourceChainClient = getClient(chainId);
		return await sourceChainClient.readContract({
			address: order.inputOracle,
			abi: POLYMER_ORACLE_ABI,
			functionName: "isProven",
			args: [output.chainId, output.oracle, output.settler, outputHash]
		});
	}

	// const validations = $derived(
	// 	orderContainer.order.outputs.map((output) => {
	// 		return orderToIntent(orderContainer)
	// 			.inputChains()
	// 			.map((inputChain) => {
	// 				return isValidated(
	// 					orderToIntent(orderContainer).orderId(),
	// 					inputChain,
	// 					orderContainer,
	// 					output,
	// 					store.fillTransactions[
	// 						hashStruct({ data: output, types: compactTypes, primaryType: "MandateOutput" })
	// 					],
	// 					refreshValidation
	// 				);
	// 			});
	// 	})
	// );

	$effect(() => {
		refreshValidation;

		const intent = orderToIntent(orderContainer);
		const orderId = intent.orderId();
		if (autoScrolledOrderId === orderId) return;

		const inputChains = intent.inputChains();
		const outputs = orderContainer.order.outputs;
		const fillTxHashes = outputs.map((output) => {
			return store.fillTransactions[outputKey(output)];
		});

		if (
			fillTxHashes.some(
				(fillTxHash) => !fillTxHash || !fillTxHash.startsWith("0x") || fillTxHash.length !== 66
			)
		)
			return;

		const currentRun = ++validationRun;
		const pairs = inputChains.flatMap((inputChain) =>
			outputs.map((output, outputIndex) => ({
				key: validationKey(inputChain, output),
				run: () =>
					isValidated(
						orderId,
						inputChain,
						orderContainer,
						output,
						fillTxHashes[outputIndex] as `0x${string}`,
						refreshValidation
					)
			}))
		);
		Promise.all(pairs.map(async (pair) => [pair.key, await pair.run()] as const))
			.then((entries) => {
				if (currentRun !== validationRun) return;
				const nextStatuses: Record<string, boolean> = {};
				for (const [key, validated] of entries) nextStatuses[key] = validated;
				validationStatuses = nextStatuses;
				if (entries.length === 0 || !entries.every(([, validated]) => validated)) return;
				autoScrolledOrderId = orderId;
				scroll(5)();
			})
			.catch((e) => console.warn("auto-scroll validation check failed", e));
	});
</script>

<ScreenFrame
	title="Submit Proof of Fill"
	description="Click on each output and wait until they turn green. Polymer does not support batch validation. Continue to the right."
>
	<div class="space-y-2">
		{#each orderToIntent(orderContainer).inputChains() as inputChain}
			<SectionCard compact>
				<ChainActionRow chainLabel={getChainName(inputChain)}>
					{#snippet action()}
						<div class="text-[11px] font-semibold text-gray-500 uppercase">Validate outputs</div>
					{/snippet}
					{#snippet chips()}
						{#each orderContainer.order.outputs as output}
							{@const status = validationStatuses[validationKey(inputChain, output)]}
							{#if status === undefined}
								<TokenAmountChip
									amountText={formatTokenAmount(
										output.amount,
										getCoin({ address: output.token, chainId: output.chainId }).decimals
									)}
									symbol={getCoin({ address: output.token, chainId: output.chainId }).name}
									tone="warning"
								/>
							{:else}
								<AwaitButton
									size="sm"
									variant={status ? "success" : "warning"}
									baseClass={["min-w-[6.5rem] justify-center"]}
									buttonFunction={status
										? async () => {}
										: Solver.validate(
												store.walletClient,
												{
													output,
													orderContainer,
													fillTransactionHash: store.fillTransactions[outputKey(output)],
													sourceChainId: Number(inputChain),
													mainnet: store.mainnet
												},
												{
													preHook,
													postHook: postHookRefreshValidate,
													account
												}
											)}
								>
									{#snippet name()}
										{formatTokenAmount(
											output.amount,
											getCoin({ address: output.token, chainId: output.chainId }).decimals
										)}
										&nbsp;
										{getCoin({
											address: output.token,
											chainId: output.chainId
										}).name.toUpperCase()}
									{/snippet}
									{#snippet awaiting()}
										Validating...
									{/snippet}
								</AwaitButton>
							{/if}
						{/each}
					{/snippet}
				</ChainActionRow>
			</SectionCard>
		{/each}
	</div>
</ScreenFrame>
