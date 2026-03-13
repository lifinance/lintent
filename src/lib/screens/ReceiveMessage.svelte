<script lang="ts">
	import {
		chainMap,
		formatTokenAmount,
		getChainName,
		getClient,
		getCoin,
		getSolanaConnection,
		isSolanaChain
	} from "$lib/config";
	import { addressToBytes32 } from "@lifi/intent";
	import { encodeMandateOutput } from "@lifi/intent";
	import { hashStruct, keccak256, parseEventLogs } from "viem";
	import type { MandateOutput, OrderContainer } from "@lifi/intent";
	import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
	import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
	import { Solver } from "$lib/libraries/solver";
	import {
		submitProofToSolanaOracle,
		deriveAttestationPda
	} from "$lib/libraries/solanaValidateLib";
	import { encodeCommonPayload, encodeFillDescription } from "$lib/libraries/solanaValidateLib";
	import { isSolanaSubmittedFillRecord } from "$lib/libraries/solanaFillLib";
	import solanaWallet from "$lib/utils/solana-wallet.svelte";
	import AwaitButton from "$lib/components/AwaitButton.svelte";
	import SolanaWalletButton from "$lib/components/SolanaWalletButton.svelte";
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

	// Solana→EVM: order has no `inputs` field (SolanaStandardOrder)
	const isSolanaToEvm = $derived(!("inputs" in orderContainer.order));

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
	const hasFillReference = (output: MandateOutput, txRef: string | undefined): txRef is string =>
		isSolanaChain(output.chainId)
			? typeof txRef === "string" && txRef.length > 0
			: typeof txRef === "string" && txRef.startsWith("0x") && txRef.length === 66;

	function markOutputValidated(output: MandateOutput) {
		const intent = orderToIntent(orderContainer);
		const orderId = intent.orderId();
		const nextStatuses = { ...validationStatuses };
		for (const inputChain of intent.inputChains()) {
			nextStatuses[validationKey(inputChain, output)] = true;
		}
		validationStatuses = nextStatuses;
		const allValidated =
			intent.inputChains().length > 0 &&
			intent
				.inputChains()
				.flatMap((inputChain) =>
					orderContainer.order.outputs.map((candidate) => validationKey(inputChain, candidate))
				)
				.every((key) => nextStatuses[key] === true);
		if (!allValidated) return;
		autoScrolledOrderId = orderId;
		scroll(5)();
	}

	/**
	 * Check if a Solana attestation PDA exists for this fill (Solana→EVM path).
	 */
	async function isValidatedSolana(
		orderId: `0x${string}`,
		output: MandateOutput,
		fillTransactionHash: `0x${string}`,
		chainId: bigint
	): Promise<boolean> {
		try {
			const { PublicKey } = await import("@solana/web3.js");
			const outputClient = getClient(output.chainId);
			const receipt = await outputClient.getTransactionReceipt({ hash: fillTransactionHash });
			const logs = parseEventLogs({
				abi: COIN_FILLER_ABI,
				eventName: "OutputFilled",
				logs: receipt.logs
			});
			const expectedHash = hashStruct({
				types: compactTypes,
				primaryType: "MandateOutput",
				data: output
			});
			const matchingLog = logs.find((log) => {
				const logHash = hashStruct({
					types: compactTypes,
					primaryType: "MandateOutput",
					data: log.args.output
				});
				return logHash === expectedHash;
			});
			if (!matchingLog) return false;
			const solverBytes32 = matchingLog.args.solver as `0x${string}`;
			const fillTimestamp =
				typeof matchingLog.args.timestamp === "number"
					? matchingLog.args.timestamp
					: Number(matchingLog.args.timestamp);
			const attestationPda = await deriveAttestationPda({
				evmChainId: output.chainId,
				output,
				proofOutput: matchingLog.args.output as MandateOutput,
				orderId,
				fillTimestamp,
				solverBytes32,
				emittingContract: matchingLog.address as `0x${string}`
			});
			const info = await getSolanaConnection(chainId).getAccountInfo(new PublicKey(attestationPda));
			return info !== null;
		} catch {
			return false;
		}
	}

	async function isValidated(
		orderId: `0x${string}`,
		chainId: bigint,
		orderContainer: OrderContainer,
		output: MandateOutput,
		fillTransactionHash: string,
		_?: any
	) {
		if (!fillTransactionHash) return false;

		// Solana input chain: check attestation PDA on Solana
		if (isSolanaChain(chainId)) {
			if (!fillTransactionHash.startsWith("0x") || fillTransactionHash.length !== 66) return false;
			return isValidatedSolana(orderId, output, fillTransactionHash as `0x${string}`, chainId);
		}

		if (isSolanaChain(output.chainId)) {
			const record = store.getTransactionReceipt(output.chainId, fillTransactionHash);
			if (!isSolanaSubmittedFillRecord(record)) return false;
			const outputHash = keccak256(
				encodeFillDescription(
					record.solverBytes32,
					orderId,
					record.fillTimestamp,
					encodeCommonPayload(output)
				)
			);
			const sourceChainClient = getClient(chainId);
			return await sourceChainClient.readContract({
				address: orderContainer.order.inputOracle,
				abi: POLYMER_ORACLE_ABI,
				functionName: "isProven",
				args: [output.chainId, output.oracle, output.settler, outputHash]
			});
		}

		const { order } = orderContainer;
		const outputClient = getClient(output.chainId);
		const transactionReceipt = await outputClient.getTransactionReceipt({
			hash: fillTransactionHash as `0x${string}`
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

	/**
	 * Returns a button function for submitting a Polymer proof to the Solana oracle (Solana→EVM).
	 */
	function solanaValidateButtonFn(output: MandateOutput) {
		return async () => {
			if (!solanaWallet.connected || !solanaWallet.publicKey) {
				throw new Error("Connect your Solana wallet first");
			}
			const fillTransactionHash = store.fillTransactions[outputKey(output)];
			if (
				!fillTransactionHash ||
				!fillTransactionHash.startsWith("0x") ||
				fillTransactionHash.length !== 66
			) {
				throw new Error(
					"Fill transaction hash not available. Please wait for the fill to be recorded."
				);
			}
			const outputClient = getClient(output.chainId);
			const receipt = await outputClient.getTransactionReceipt({ hash: fillTransactionHash });
			const logs = parseEventLogs({
				abi: COIN_FILLER_ABI,
				eventName: "OutputFilled",
				logs: receipt.logs
			});
			const expectedHash = hashStruct({
				types: compactTypes,
				primaryType: "MandateOutput",
				data: output
			});
			const matchingLog = logs.find((log) => {
				const logHash = hashStruct({
					types: compactTypes,
					primaryType: "MandateOutput",
					data: log.args.output
				});
				return logHash === expectedHash;
			});
			if (!matchingLog) throw new Error("Could not find OutputFilled event for this output");
			const solverBytes32 = matchingLog.args.solver as `0x${string}`;
			const fillTimestamp =
				typeof matchingLog.args.timestamp === "number"
					? matchingLog.args.timestamp
					: Number(matchingLog.args.timestamp);
			const orderId = orderToIntent(orderContainer).orderId();
			await submitProofToSolanaOracle({
				evmChainId: output.chainId,
				output,
				proofOutput: matchingLog.args.output as MandateOutput,
				orderId,
				fillTimestamp,
				solverBytes32,
				emittingContract: matchingLog.address as `0x${string}`,
				fillBlockNumber: Number(receipt.blockNumber),
				globalLogIndex: matchingLog.logIndex,
				mainnet: store.mainnet,
				solanaPublicKey: solanaWallet.publicKey,
				walletAdapter: solanaWallet.adapter,
				connection: getSolanaConnection(
					store.mainnet ? chainMap.solanaMainnet.id : chainMap.solanaDevnet.id
				)
			});
			markOutputValidated(output);
			await postHookRefreshValidate();
		};
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
			return store.fillTransactions[
				hashStruct({
					data: output,
					types: compactTypes,
					primaryType: "MandateOutput"
				})
			];
		});

		if (outputs.some((output, index) => !hasFillReference(output, fillTxHashes[index]))) return;

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
						fillTxHashes[outputIndex] as string,
						refreshValidation
					)
			}))
		);
		Promise.allSettled(pairs.map(async (pair) => [pair.key, await pair.run()] as const))
			.then((results) => {
				if (currentRun !== validationRun) return;
				const nextStatuses: Record<string, boolean> = {};
				for (let i = 0; i < results.length; i++) {
					const result = results[i];
					const key = pairs[i].key;
					nextStatuses[key] = result.status === "fulfilled" ? result.value[1] : false;
				}
				validationStatuses = nextStatuses;
				const allValidated = pairs.length > 0 && pairs.every((p) => nextStatuses[p.key] === true);
				if (!allValidated) return;
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
							{:else if isSolanaToEvm && !solanaWallet.connected}
								<SolanaWalletButton />
							{:else}
								{@const fillTxHash =
									store.fillTransactions[
										hashStruct({ data: output, types: compactTypes, primaryType: "MandateOutput" })
									]}
								<AwaitButton
									size="sm"
									variant={status ? "success" : "warning"}
									disabled={status === true}
									baseClass={["min-w-[6.5rem] justify-center"]}
									buttonFunction={status
										? async () => {}
										: isSolanaToEvm
											? solanaValidateButtonFn(output)
											: Solver.validate(
													store.walletClient,
													{
														output,
														orderContainer,
														fillTransactionHash: fillTxHash,
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
										{#if status}
											Validated
										{:else}
											{formatTokenAmount(
												output.amount,
												getCoin({ address: output.token, chainId: output.chainId }).decimals
											)}
											&nbsp;
											{getCoin({
												address: output.token,
												chainId: output.chainId
											}).name.toUpperCase()}
										{/if}
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
