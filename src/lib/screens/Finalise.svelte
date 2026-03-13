<script lang="ts">
	import AwaitButton from "../components/AwaitButton.svelte";
	import SolanaWalletButton from "$lib/components/SolanaWalletButton.svelte";
	import ScreenFrame from "$lib/components/ui/ScreenFrame.svelte";
	import SectionCard from "$lib/components/ui/SectionCard.svelte";
	import ChainActionRow from "$lib/components/ui/ChainActionRow.svelte";
	import TokenAmountChip from "$lib/components/ui/TokenAmountChip.svelte";

	import { Solver } from "$lib/libraries/solver";
	import { deriveAttestationPda } from "$lib/libraries/solanaValidateLib";
	import { finaliseSolanaEscrow, deriveOrderContextPda } from "$lib/libraries/solanaFinaliseLib";
	import type { MandateOutput, OrderContainer, SolanaStandardOrder } from "@lifi/intent";
	import {
		chainMap,
		COMPACT,
		formatTokenAmount,
		getChainName,
		getClient,
		getCoin,
		INPUT_SETTLER_COMPACT_LIFI,
		INPUT_SETTLER_ESCROW_LIFI,
		MULTICHAIN_INPUT_SETTLER_COMPACT,
		MULTICHAIN_INPUT_SETTLER_ESCROW,
		solanaDevnetConnection
	} from "$lib/config";
	import { COMPACT_ABI } from "$lib/abi/compact";
	import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
	import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
	import { idToToken } from "@lifi/intent";
	import { parseEventLogs, hashStruct } from "viem";
	import { compactTypes } from "@lifi/intent";
	import solanaWallet from "$lib/utils/solana-wallet.svelte";
	import store from "$lib/state.svelte";
	import { orderToIntent } from "@lifi/intent";

	const SOLANA_DEVNET_CHAIN_ID = BigInt(chainMap.solanaDevnet.id);

	let {
		orderContainer,
		account,
		preHook,
		postHook
	}: {
		orderContainer: OrderContainer;
		preHook?: (chainId: number) => Promise<any>;
		postHook?: () => Promise<any>;
		account: () => `0x${string}`;
	} = $props();

	let refreshClaimed = $state(0);
	let claimedByChain = $state<Record<string, boolean>>({});
	let claimStatusRun = 0;
	const inputChains = $derived(orderToIntent(orderContainer).inputChains());
	const getInputsForChain = (container: OrderContainer, inputChain: bigint): [bigint, bigint][] => {
		const { order } = container;
		if ("originChainId" in order) {
			if (!("inputs" in order)) return []; // SolanaStandardOrder — no [bigint, bigint][] inputs
			return order.originChainId === inputChain ? order.inputs : [];
		}
		return order.inputs.find((chainInput) => chainInput.chainId === inputChain)?.inputs ?? [];
	};
	const allFinalised = $derived(
		inputChains.length > 0 &&
			inputChains.every((chainId) => claimedByChain[chainId.toString()] === true)
	);
	const confettiPieces = Array.from({ length: 28 }, (_, i) => ({
		left: (i * 13) % 100,
		delay: (i % 9) * 0.18,
		duration: 2.8 + (i % 5) * 0.35,
		rotation: (i * 47) % 360,
		hue: (i * 29) % 360
	}));

	const postHookRefreshValidate = async () => {
		if (postHook) await postHook();
		refreshClaimed += 1;
	};

	const outputKey = (output: (typeof orderContainer.order.outputs)[number]) =>
		hashStruct({
			data: output,
			types: compactTypes,
			primaryType: "MandateOutput"
		});

	const fillTransactionHashesFor = (container: OrderContainer) =>
		container.order.outputs.map((output) => store.fillTransactions[outputKey(output)]);

	const isValidFillTxHash = (hash: unknown): hash is `0x${string}` =>
		typeof hash === "string" && hash.startsWith("0x") && hash.length === 66;

	// Order status enum
	const OrderStatus_None = 0;
	const OrderStatus_Deposited = 1;
	const OrderStatus_Claimed = 2;
	const OrderStatus_Refunded = 3;

	async function isClaimed(chainId: bigint, container: OrderContainer, _: any) {
		const { order, inputSettler } = container;

		// Solana→EVM: order_context PDA is closed after finalise
		if (chainId === SOLANA_DEVNET_CHAIN_ID) {
			const { PublicKey } = await import("@solana/web3.js");
			const orderContextPda = await deriveOrderContextPda(
				order as SolanaStandardOrder,
				solanaDevnetConnection
			);
			const info = await solanaDevnetConnection.getAccountInfo(new PublicKey(orderContextPda));
			return info === null; // null = closed = finalised
		}

		const inputChainClient = getClient(chainId);
		const intent = orderToIntent(container);
		const orderId = intent.orderId();
		// Determine the order type.
		if (
			inputSettler === INPUT_SETTLER_ESCROW_LIFI ||
			inputSettler === MULTICHAIN_INPUT_SETTLER_ESCROW
		) {
			// Check order status
			const orderStatus = await inputChainClient.readContract({
				address: inputSettler,
				abi: SETTLER_ESCROW_ABI,
				functionName: "orderStatus",
				args: [orderId]
			});
			return orderStatus === OrderStatus_Claimed || orderStatus === OrderStatus_Refunded;
		} else if (
			inputSettler === INPUT_SETTLER_COMPACT_LIFI ||
			inputSettler === MULTICHAIN_INPUT_SETTLER_COMPACT
		) {
			// Check claim status
			const flattenedInputs =
				"originChainId" in order && "inputs" in order
					? order.inputs
					: "inputs" in order
						? order.inputs[0]?.inputs
						: [];
			if (!flattenedInputs || flattenedInputs.length === 0) return false;

			const [token, allocator, resetPeriod, scope] = await inputChainClient.readContract({
				address: COMPACT,
				abi: COMPACT_ABI,
				functionName: "getLockDetails",
				args: [flattenedInputs[0][0]]
			});
			// Check if nonce is spent.
			return await inputChainClient.readContract({
				address: COMPACT,
				abi: COMPACT_ABI,
				functionName: "hasConsumedAllocatorNonce",
				args: [order.nonce, allocator]
			});
		}
		return false;
	}

	/**
	 * Returns a button function for finalising a Solana→EVM order.
	 * Reads EVM fill receipts to build solveParams, derives attestation PDAs, then calls finaliseSolanaEscrow().
	 */
	function solanaClaimFn(container: OrderContainer) {
		return async () => {
			if (!solanaWallet.connected || !solanaWallet.publicKey) {
				throw new Error("Connect your Solana wallet first");
			}
			const solanaOrder = container.order as SolanaStandardOrder;
			const orderId = orderToIntent(container).orderId();
			const outputs = solanaOrder.outputs;

			// Collect fill tx hashes for all outputs
			const fillTxHashes = outputs.map(
				(output) =>
					store.fillTransactions[
						hashStruct({ data: output, types: compactTypes, primaryType: "MandateOutput" })
					]
			);
			if (fillTxHashes.some((h) => !h || !h.startsWith("0x") || h.length !== 66)) {
				throw new Error("Missing fill transaction hashes");
			}

			// Fetch EVM fill receipts and parse solver + timestamp for each output
			const outputClient = (output: (typeof outputs)[number]) => getClient(output.chainId);
			const receipts = await Promise.all(
				outputs.map((output, i) =>
					outputClient(output).getTransactionReceipt({
						hash: fillTxHashes[i] as `0x${string}`
					})
				)
			);
			const blocks = await Promise.all(
				receipts.map((r, i) => outputClient(outputs[i]).getBlock({ blockHash: r.blockHash }))
			);

			// Extract solver bytes32 from OutputFilled event for each output
			const solveParams: { solver: number[]; timestamp: number }[] = [];
			const attestationPdas: string[] = [];

			for (let i = 0; i < outputs.length; i++) {
				const output = outputs[i];
				const receipt = receipts[i];
				const block = blocks[i];
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
				if (!matchingLog) throw new Error(`Could not find OutputFilled event for output ${i}`);

				const solverBytes32 = matchingLog.args.solver as `0x${string}`;
				const fillTimestamp =
					typeof matchingLog.args.timestamp === "number"
						? matchingLog.args.timestamp
						: Number(matchingLog.args.timestamp);

				// solver as 32-byte array for Anchor
				solveParams.push({
					solver: Array.from(Buffer.from(solverBytes32.slice(2), "hex")),
					timestamp: fillTimestamp
				});

				// Derive attestation PDA
				const attestationPda = await deriveAttestationPda({
					evmChainId: output.chainId,
					output,
					proofOutput: matchingLog.args.output as MandateOutput,
					orderId,
					fillTimestamp,
					solverBytes32,
					emittingContract: matchingLog.address as `0x${string}`
				});
				attestationPdas.push(attestationPda);
			}

			return await finaliseSolanaEscrow({
				order: solanaOrder,
				solveParams,
				attestationPdas,
				solanaPublicKey: solanaWallet.publicKey,
				walletAdapter: solanaWallet.adapter,
				connection: solanaDevnetConnection
			});
		};
	}

	$effect(() => {
		refreshClaimed;
		const currentRun = ++claimStatusRun;
		Promise.all(
			inputChains.map(
				async (inputChain) =>
					[
						inputChain.toString(),
						await isClaimed(inputChain, orderContainer, refreshClaimed)
					] as const
			)
		)
			.then((entries) => {
				if (currentRun !== claimStatusRun) return;
				const next: Record<string, boolean> = {};
				for (const [key, value] of entries) next[key] = value;
				claimedByChain = next;
			})
			.catch((e) => console.warn("claim status refresh failed", e));
	});
</script>

<ScreenFrame title="Finalise Intent" description="Finalise the order to receive the input assets.">
	<div class="relative space-y-2">
		{#if allFinalised}
			<div class="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
				{#each confettiPieces as piece, i}
					<div
						class="confetti-piece"
						style={`left:${piece.left}%; animation-delay:${piece.delay}s; animation-duration:${piece.duration}s; --confetti-rotation:${piece.rotation}deg; --confetti-color:hsl(${piece.hue} 92% 62%);`}
					></div>
				{/each}
			</div>
		{/if}
		{#if allFinalised}
			<div
				class="relative overflow-hidden rounded border border-emerald-200 bg-gradient-to-r from-emerald-50 via-sky-50 to-emerald-50 px-3 py-2"
			>
				<div class="text-center text-sm font-semibold text-emerald-800">All inputs finalised</div>
				<div class="text-center text-xs text-emerald-700">Intent fully solved.</div>
			</div>
		{/if}
		{#each inputChains as inputChain}
			<SectionCard compact>
				<ChainActionRow chainLabel={getChainName(inputChain)}>
					{#snippet action()}
						{@const isClaimedStatus = claimedByChain[inputChain.toString()]}
						{#if isClaimedStatus === undefined}
							<button
								type="button"
								class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
								disabled
							>
								Finalise
							</button>
						{:else if isClaimedStatus}
							<button
								type="button"
								class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
								disabled
							>
								Finalised
							</button>
						{:else if inputChain === SOLANA_DEVNET_CHAIN_ID && !solanaWallet.connected}
							<SolanaWalletButton />
						{:else}
							{@const fillTransactionHashes = fillTransactionHashesFor(orderContainer)}
							{@const canClaim = fillTransactionHashes.every((hash) => isValidFillTxHash(hash))}
							{#if !canClaim}
								<button
									type="button"
									class="h-8 rounded border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-400"
									disabled
								>
									Await fills
								</button>
							{:else if inputChain === SOLANA_DEVNET_CHAIN_ID}
								<AwaitButton buttonFunction={solanaClaimFn(orderContainer)}>
									{#snippet name()}
										Claim
									{/snippet}
									{#snippet awaiting()}
										Waiting for transaction...
									{/snippet}
								</AwaitButton>
							{:else}
								<AwaitButton
									buttonFunction={Solver.claim(
										store.walletClient,
										{
											sourceChainId: Number(inputChain),
											orderContainer,
											fillTransactionHashes: fillTransactionHashes as string[]
										},
										{
											account,
											preHook,
											postHook: postHookRefreshValidate
										}
									)}
								>
									{#snippet name()}
										Claim
									{/snippet}
									{#snippet awaiting()}
										Waiting for transaction...
									{/snippet}
								</AwaitButton>
							{/if}
						{/if}
					{/snippet}
					{#snippet chips()}
						{#if inputChain === SOLANA_DEVNET_CHAIN_ID}
							{@const solanaOrder = orderContainer.order as SolanaStandardOrder}
							<TokenAmountChip
								amountText={formatTokenAmount(
									solanaOrder.input.amount,
									getCoin({
										address: solanaOrder.input.token,
										chainId: inputChain
									}).decimals
								)}
								symbol={getCoin({
									address: solanaOrder.input.token,
									chainId: inputChain
								}).name}
								tone="neutral"
							/>
						{:else}
							{#each getInputsForChain(orderContainer, inputChain) as input}
								<TokenAmountChip
									amountText={formatTokenAmount(
										input[1],
										getCoin({
											address: idToToken(input[0]),
											chainId: inputChain
										}).decimals
									)}
									symbol={getCoin({
										address: idToToken(input[0]),
										chainId: inputChain
									}).name}
									tone="neutral"
								/>
							{/each}
						{/if}
					{/snippet}
				</ChainActionRow>
			</SectionCard>
		{/each}
	</div>
</ScreenFrame>

<style>
	.confetti-piece {
		position: absolute;
		top: -12%;
		width: 0.4rem;
		height: 0.85rem;
		background: var(--confetti-color);
		border-radius: 2px;
		opacity: 0.9;
		transform: rotate(var(--confetti-rotation));
		animation-name: confetti-fall;
		animation-timing-function: linear;
		animation-iteration-count: infinite;
	}

	@keyframes confetti-fall {
		0% {
			transform: translate3d(0, -10%, 0) rotate(0deg);
			opacity: 0;
		}
		10% {
			opacity: 0.95;
		}
		100% {
			transform: translate3d(0, 1200%, 0) rotate(700deg);
			opacity: 0;
		}
	}
</style>
