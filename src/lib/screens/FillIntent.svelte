<script lang="ts">
	import {
		BYTES32_ZERO,
		formatTokenAmount,
		getChainName,
		getClient,
		getCoin,
		getSolanaConnection,
		isSolanaChain,
		chainMap
	} from "$lib/config";
	import { addressToBytes32, bytes32ToAddress } from "@lifi/intent";
	import { getOutputHash } from "@lifi/intent";
	import type { MandateOutput, OrderContainer } from "@lifi/intent";
	import { isValidSolanaAddress, solanaAddressToBytes32 } from "$lib/utils/solana";
	import { Solver } from "$lib/libraries/solver";
	import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
	import { fillAndSubmitSolanaOutputs } from "$lib/libraries/solanaFillLib";
	import AwaitButton from "$lib/components/AwaitButton.svelte";
	import SolanaWalletButton from "$lib/components/SolanaWalletButton.svelte";
	import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
	import SectionCard from "$lib/components/ui/SectionCard.svelte";
	import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
	import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";
	import store from "$lib/state.svelte";
	import { containerToIntent } from "$lib/utils/intent";
	import { compactTypes } from "@lifi/intent";
	import { hashStruct } from "viem";
	import solanaWallet from "$lib/utils/solana-wallet.svelte";

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

	// Solana→EVM: input chain is Solana
	const isSolanaToEvm = $derived(
		"originChainId" in orderContainer.order && isSolanaChain(orderContainer.order.originChainId)
	);

	// EVM→Solana: input chain is EVM, some outputs are on Solana
	const hasEvmInputs = $derived(
		"originChainId" in orderContainer.order && !isSolanaChain(orderContainer.order.originChainId)
	);
	const hasSolanaOutputs = $derived(
		orderContainer.order.outputs.some((o) => isSolanaChain(o.chainId))
	);
	const isEvmToSolana = $derived(hasEvmInputs && hasSolanaOutputs);

	let solanaSolverAddress = $state("");
	let evmSolverAddress = $state(account() ?? "");

	let refreshValidation = $state(0);
	let autoScrolledOrderId = $state<`0x${string}` | null>(null);
	let fillRun = 0;
	let fillStatuses = $state<Record<string, `0x${string}` | "solana-filled">>({});
	const postHookScroll = async () => {
		await postHook();
		refreshValidation += 1;
	};

	async function isFilled(orderId: `0x${string}`, output: MandateOutput, _?: any) {
		if (isSolanaChain(output.chainId)) {
			const key = solanaRecordKey(orderId, output);
			const record = store.getSolanaFillRecord(key);
			if (record) return "solana-filled" as const;
			return BYTES32_ZERO as `0x${string}`;
		}
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

	const solanaRecordKey = (orderId: `0x${string}`, output: MandateOutput) =>
		`${orderId}:${outputKey(output)}`;

	$effect(() => {
		refreshValidation;

		const orderId = containerToIntent(orderContainer).orderId();
		if (autoScrolledOrderId === orderId) return;

		const outputs = sortOutputsByChain(orderContainer).flatMap(([, chainOutputs]) => chainOutputs);
		if (outputs.length === 0) return;

		const currentRun = ++fillRun;
		Promise.all(
			outputs.map(async (output) => [outputKey(output), await isFilled(orderId, output)] as const)
		)
			.then((entries) => {
				if (currentRun !== fillRun) return;
				const nextStatuses: Record<string, `0x${string}` | "solana-filled"> = {};
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
			await postHookScroll();
		};
	};

	/**
	 * Fill Solana outputs for an EVM→Solana intent.
	 * Uses the Solana wallet to fill on the output settler, then submits to Polymer oracle.
	 */
	function solanaFillWrapper(outputs: MandateOutput[]) {
		return async () => {
			if (!solanaWallet.connected || !solanaWallet.publicKey) {
				throw new Error("Connect your Solana wallet first");
			}
			const solverAddr = (evmSolverAddress.trim() || account()) as `0x${string}`;
			if (!solverAddr || !solverAddr.startsWith("0x") || solverAddr.length !== 42) {
				throw new Error("Invalid EVM solver address. Must be a valid 0x address.");
			}
			const orderId = containerToIntent(orderContainer).orderId();
			const solverBytes32 = addressToBytes32(solverAddr);
			const connection = getSolanaConnection(
				store.mainnet ? chainMap.solanaMainnet.id : chainMap.solanaDevnet.id
			);

			const records = await fillAndSubmitSolanaOutputs({
				orderId,
				outputs,
				fillDeadline: orderContainer.order.fillDeadline,
				solverBytes32,
				solanaPublicKey: solanaWallet.publicKey,
				walletAdapter: solanaWallet.adapter!,
				connection
			});

			for (let i = 0; i < outputs.length; i++) {
				const output = outputs[i];
				const record = records[i];
				const oKey = outputKey(output);
				const rKey = solanaRecordKey(orderId, output);
				store.fillTransactions[oKey] = record.fillSignature;
				store.solanaFillRecords[rKey] = record;
				await store.saveFillTransaction(oKey, record.fillSignature as `0x${string}`);
				await store.saveSolanaFillRecord(rKey, record);
			}

			// Force the fill status to green immediately (don't wait for the polling $effect)
			const nextStatuses = { ...fillStatuses };
			for (const output of outputs) {
				nextStatuses[outputKey(output)] = "solana-filled";
			}
			fillStatuses = nextStatuses;

			// Check if ALL outputs are now filled (including any EVM outputs filled earlier)
			const allFilled = orderContainer.order.outputs.every((o) => {
				const key = outputKey(o);
				return nextStatuses[key] !== undefined && nextStatuses[key] !== BYTES32_ZERO;
			});
			if (allFilled) {
				autoScrolledOrderId = containerToIntent(orderContainer).orderId();
				scroll(4)();
			}

			await postHookScroll();
		};
	}
</script>

<ScreenFrame
	title="Fill Intent"
	description="Fill each chain once and continue to the right. If you refreshed the page provide your fill tx hash in the input box."
>
	<div class="space-y-2">
		{#if isSolanaToEvm}
			<SectionCard compact>
				<div class="flex flex-col gap-1 px-1 py-1">
					<label class="text-xs text-gray-500" for="solana-solver-address">
						Solana Solver Address (your Solana pubkey — used to receive the claim)
					</label>
					<input
						id="solana-solver-address"
						class="rounded border px-2 py-1 text-xs"
						bind:value={solanaSolverAddress}
						placeholder="Base58 Solana address..."
					/>
				</div>
			</SectionCard>
		{/if}
		{#if isEvmToSolana}
			<SectionCard compact>
				<div class="flex flex-col gap-1 px-1 py-1">
					<label class="text-xs text-gray-500" for="evm-solver-address">
						Solver Address (EVM address that will claim the input tokens)
					</label>
					<input
						id="evm-solver-address"
						class="rounded border px-2 py-1 font-mono text-xs"
						bind:value={evmSolverAddress}
						placeholder="0x..."
					/>
				</div>
			</SectionCard>
		{/if}
		{#each sortOutputsByChain(orderContainer) as chainIdAndOutputs}
			{@const isSolanaOutput = isSolanaChain(chainIdAndOutputs[0])}
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
						{:else if isSolanaOutput && !solanaWallet.connected}
							<SolanaWalletButton />
						{:else if isSolanaToEvm && !isSolanaOutput && !isValidSolanaAddress(solanaSolverAddress)}
							<button
								type="button"
								class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
								disabled
							>
								Enter solver address
							</button>
						{:else if isSolanaOutput}
							<AwaitButton
								variant={chainStatuses.every((v) => v === BYTES32_ZERO) ? "default" : "muted"}
								buttonFunction={chainStatuses.every((v) => v === BYTES32_ZERO)
									? solanaFillWrapper(chainIdAndOutputs[1])
									: async () => {}}
							>
								{#snippet name()}
									Fill (Solana)
								{/snippet}
								{#snippet awaiting()}
									Filling on Solana...
								{/snippet}
							</AwaitButton>
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
													outputs: chainIdAndOutputs[1],
													solverBytes32:
														isSolanaToEvm && isValidSolanaAddress(solanaSolverAddress)
															? solanaAddressToBytes32(solanaSolverAddress)
															: undefined
												},
												{
													preHook,
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
