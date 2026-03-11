import {
	BYTES32_ZERO,
	COMPACT,
	INPUT_SETTLER_COMPACT_LIFI,
	INPUT_SETTLER_ESCROW_LIFI,
	MULTICHAIN_INPUT_SETTLER_COMPACT,
	MULTICHAIN_INPUT_SETTLER_ESCROW,
	getClient,
	solanaDevnetConnection
} from "$lib/config";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { COMPACT_ABI } from "$lib/abi/compact";
import { hashStruct, keccak256, parseEventLogs } from "viem";
import { compactTypes } from "@lifi/intent";
import { getOutputHash, encodeMandateOutput } from "@lifi/intent";
import { addressToBytes32, bytes32ToAddress } from "@lifi/intent";
import { orderToIntent } from "@lifi/intent";
import { getOrFetchRpc } from "$lib/libraries/rpcCache";
import { deriveAttestationPda } from "$lib/libraries/solanaValidateLib";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import store from "$lib/state.svelte";

const PROGRESS_TTL_MS = 30_000;
const OrderStatus_Claimed = 2;
const OrderStatus_Refunded = 3;
const SOLANA_DEVNET_CHAIN_ID = 1151111081099712n;

export type FlowCheckState = {
	allFilled: boolean;
	allValidated: boolean;
	allFinalised: boolean;
};

export function getOutputStorageKey(output: MandateOutput) {
	return hashStruct({
		data: output,
		types: compactTypes,
		primaryType: "MandateOutput"
	});
}

function isValidHash(hash: string | undefined): hash is `0x${string}` {
	return !!hash && hash.startsWith("0x") && hash.length === 66;
}

async function isOutputFilled(orderId: `0x${string}`, output: MandateOutput) {
	const outputKey = getOutputStorageKey(output);
	return getOrFetchRpc(
		`progress:filled:${orderId}:${outputKey}`,
		async () => {
			const outputClient = getClient(output.chainId);
			const outputHash = getOutputHash(output);
			const result = await outputClient.readContract({
				address: bytes32ToAddress(output.settler),
				abi: COIN_FILLER_ABI,
				functionName: "getFillRecord",
				args: [orderId, outputHash]
			});
			return result !== BYTES32_ZERO;
		},
		{ ttlMs: PROGRESS_TTL_MS }
	);
}

async function isOutputValidatedOnChain(
	orderId: `0x${string}`,
	inputChain: bigint,
	orderContainer: OrderContainer,
	output: MandateOutput,
	fillTransactionHash: `0x${string}`
) {
	const outputKey = getOutputStorageKey(output);
	const cachedReceipt = store.getTransactionReceipt(output.chainId, fillTransactionHash);
	const receipt = (
		cachedReceipt
			? cachedReceipt
			: await getOrFetchRpc(
					`progress:receipt:${output.chainId.toString()}:${fillTransactionHash}`,
					async () => {
						const outputClient = getClient(output.chainId);
						return outputClient.getTransactionReceipt({
							hash: fillTransactionHash
						});
					},
					{ ttlMs: PROGRESS_TTL_MS }
				)
	) as {
		blockHash: `0x${string}`;
		from: `0x${string}`;
	};
	if (!cachedReceipt) {
		store
			.saveTransactionReceipt(output.chainId, fillTransactionHash, receipt)
			.catch((error) => console.warn("saveTransactionReceipt error", error));
	}

	if (inputChain === SOLANA_DEVNET_CHAIN_ID) {
		return getOrFetchRpc(
			`progress:solana-proven:${orderId}:${inputChain.toString()}:${outputKey}:${fillTransactionHash}`,
			async () => {
				const outputClient = getClient(output.chainId);
				const logs = parseEventLogs({
					abi: COIN_FILLER_ABI,
					eventName: "OutputFilled",
					logs: (receipt as { logs: unknown[] }).logs
				});
				const expectedHash = hashStruct({
					types: compactTypes,
					primaryType: "MandateOutput",
					data: output
				});
				const matchingLog = logs.find((log) => {
					const logOutputHash = hashStruct({
						types: compactTypes,
						primaryType: "MandateOutput",
						data: log.args.output
					});
					return logOutputHash === expectedHash;
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
				const { PublicKey } = await import("@solana/web3.js");
				const info = await solanaDevnetConnection.getAccountInfo(new PublicKey(attestationPda));
				return info !== null;
			},
			{ ttlMs: PROGRESS_TTL_MS }
		);
	}

	const block = await getOrFetchRpc(
		`progress:block:${output.chainId.toString()}:${receipt.blockHash}`,
		async () => {
			const outputClient = getClient(output.chainId);
			return outputClient.getBlock({ blockHash: receipt.blockHash });
		},
		{ ttlMs: PROGRESS_TTL_MS }
	);

	const encodedOutput = encodeMandateOutput({
		solver: addressToBytes32(receipt.from),
		orderId,
		timestamp: Number(block.timestamp),
		output
	});
	const outputHash = keccak256(encodedOutput);

	return getOrFetchRpc(
		`progress:proven:${orderId}:${inputChain.toString()}:${outputKey}:${fillTransactionHash}`,
		async () => {
			const sourceChainClient = getClient(inputChain);
			return sourceChainClient.readContract({
				address: orderContainer.order.inputOracle,
				abi: POLYMER_ORACLE_ABI,
				functionName: "isProven",
				args: [output.chainId, output.oracle, output.settler, outputHash]
			});
		},
		{ ttlMs: PROGRESS_TTL_MS }
	);
}

async function isInputChainFinalised(chainId: bigint, container: OrderContainer) {
	const { order, inputSettler } = container;
	const inputChainClient = getClient(chainId);
	const intent = orderToIntent(container);
	const orderId = intent.orderId();

	if (
		inputSettler === INPUT_SETTLER_ESCROW_LIFI ||
		inputSettler === MULTICHAIN_INPUT_SETTLER_ESCROW
	) {
		return getOrFetchRpc(
			`progress:finalised:escrow:${orderId}:${chainId.toString()}`,
			async () => {
				const orderStatus = await inputChainClient.readContract({
					address: inputSettler,
					abi: SETTLER_ESCROW_ABI,
					functionName: "orderStatus",
					args: [orderId]
				});
				return orderStatus === OrderStatus_Claimed || orderStatus === OrderStatus_Refunded;
			},
			{ ttlMs: PROGRESS_TTL_MS }
		);
	}

	if (
		inputSettler === INPUT_SETTLER_COMPACT_LIFI ||
		inputSettler === MULTICHAIN_INPUT_SETTLER_COMPACT
	) {
		const flattenedInputs =
			"originChainId" in order && "inputs" in order
				? order.inputs
				: "inputs" in order
					? order.inputs[0]?.inputs
					: [];
		if (!flattenedInputs || flattenedInputs.length === 0) return false;

		return getOrFetchRpc(
			`progress:finalised:compact:${orderId}:${chainId.toString()}`,
			async () => {
				const [, allocator] = await inputChainClient.readContract({
					address: COMPACT,
					abi: COMPACT_ABI,
					functionName: "getLockDetails",
					args: [flattenedInputs[0][0]]
				});
				return inputChainClient.readContract({
					address: COMPACT,
					abi: COMPACT_ABI,
					functionName: "hasConsumedAllocatorNonce",
					args: [order.nonce, allocator]
				});
			},
			{ ttlMs: PROGRESS_TTL_MS }
		);
	}

	return false;
}

export async function getOrderProgressChecks(
	orderContainer: OrderContainer,
	fillTransactions: Record<string, `0x${string}`>
): Promise<FlowCheckState> {
	try {
		const intent = orderToIntent(orderContainer);
		const orderId = intent.orderId();
		const inputChains = intent.inputChains();
		const outputs = orderContainer.order.outputs;

		const filledStates = await Promise.all(
			outputs.map((output) => isOutputFilled(orderId, output))
		);
		const allFilled = outputs.length > 0 && filledStates.every(Boolean);

		let allValidated = false;
		if (allFilled && inputChains.length > 0) {
			const validatedPairs = await Promise.all(
				inputChains.flatMap((inputChain) =>
					outputs.map(async (output) => {
						const fillHash = fillTransactions[getOutputStorageKey(output)];
						if (!isValidHash(fillHash)) return false;
						return isOutputValidatedOnChain(orderId, inputChain, orderContainer, output, fillHash);
					})
				)
			);
			allValidated = validatedPairs.length > 0 && validatedPairs.every(Boolean);
		}

		let allFinalised = false;
		if (allValidated && inputChains.length > 0) {
			const finalisedStates = await Promise.all(
				inputChains.map((chainId) => isInputChainFinalised(chainId, orderContainer))
			);
			allFinalised = finalisedStates.every(Boolean);
		}

		return {
			allFilled,
			allValidated,
			allFinalised
		};
	} catch (error) {
		console.warn("progress checks failed", error);
		return {
			allFilled: false,
			allValidated: false,
			allFinalised: false
		};
	}
}
