import {
  BYTES32_ZERO,
  COMPACT,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  getClient
} from "$lib/config";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { COMPACT_ABI } from "$lib/abi/compact";
import { hashStruct, keccak256 } from "viem";
import { compactTypes } from "@lifi/intent";
import { getOutputHash, encodeMandateOutput } from "@lifi/intent";
import { bytes32ToAddress } from "@lifi/intent";
import { containerToIntent } from "$lib/utils/intent";
import { getOrFetchRpc } from "$lib/libraries/rpcCache";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
import { isValidTxRef, type TxRef } from "$lib/utils/txRef";
import { getSolanaReads } from "$lib/solana/client";
import {
  readIsLocallyAttested,
  readIsOrderFinalised,
  readIsOutputFilled as readIsSolanaOutputFilled,
  readIsProvenOnSolana
} from "$lib/solana/reads";
import { getFillDetails } from "$lib/libraries/fillEvent";
import { getTronReads } from "$lib/tron/client";
import { readIsOutputFilled, readIsProven, readOrderStatus } from "$lib/tron/reads";

const PROGRESS_TTL_MS = 30_000;
const OrderStatus_Claimed = 2;
const OrderStatus_Refunded = 3;

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

async function isOutputFilled(orderId: `0x${string}`, output: MandateOutput) {
  const outputKey = getOutputStorageKey(output);
  const outputHash = getOutputHash(output);
  if (isSolanaChain(output.chainId)) {
    return getOrFetchRpc(
      `progress:filled:${orderId}:${outputKey}`,
      async () =>
        readIsSolanaOutputFilled(await getSolanaReads(output.chainId), { orderId, output }),
      { ttlMs: PROGRESS_TTL_MS }
    );
  }
  if (isTronChain(output.chainId)) {
    return getOrFetchRpc(
      `progress:filled:${orderId}:${outputKey}`,
      async () => readIsOutputFilled(await getTronReads(), output.settler, orderId, outputHash),
      { ttlMs: PROGRESS_TTL_MS }
    );
  }
  return getOrFetchRpc(
    `progress:filled:${orderId}:${outputKey}`,
    async () => {
      const outputClient = getClient(output.chainId);
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
  fillTransactionHash: TxRef
) {
  const outputKey = getOutputStorageKey(output);

  // Solver and timestamp come from the OutputFilled event — the recorded
  // solver may be an override, not the transaction sender, and the recorded
  // timestamp is the exact value hashed into the attested payload.
  const { solver, timestamp } = await getFillDetails(orderId, output, fillTransactionHash);

  const encodedOutput = encodeMandateOutput({
    solver,
    orderId,
    timestamp,
    output
  });
  const outputHash = keccak256(encodedOutput);

  const provenCacheKey = `progress:proven:${orderId}:${inputChain.toString()}:${outputKey}:${fillTransactionHash}`;
  if (isSolanaChain(inputChain)) {
    // On Solana "proven" is not a mapping lookup — the oracle CREATES an
    // attestation account, so its existence is the proof. Same-chain fills
    // never reach an oracle at all: the fill itself writes a LocalAttestation.
    const sameChain = output.chainId === inputChain;
    return getOrFetchRpc(
      provenCacheKey,
      async () => {
        const reads = await getSolanaReads(inputChain);
        if (sameChain) {
          return readIsLocallyAttested(reads, { orderId, output, solver });
        }
        return readIsProvenOnSolana(reads, {
          inputOracle: orderContainer.order.inputOracle,
          output,
          payloadHash: outputHash
        });
      },
      { ttlMs: PROGRESS_TTL_MS }
    );
  }
  if (isTronChain(inputChain)) {
    return getOrFetchRpc(
      provenCacheKey,
      async () =>
        readIsProven(
          await getTronReads(),
          orderContainer.order.inputOracle,
          output.chainId,
          output.oracle,
          output.settler,
          outputHash
        ),
      { ttlMs: PROGRESS_TTL_MS }
    );
  }

  return getOrFetchRpc(
    provenCacheKey,
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
  const intent = containerToIntent(container);
  const orderId = intent.orderId();

  if (isSolanaChain(chainId)) {
    // No status enum on Solana: finalise and refund both close order_context,
    // so "context gone, consumed_order still present" is the terminal signal.
    // That folds Claimed and Refunded into one state, exactly as the EVM and
    // Tron branches below already do.
    return getOrFetchRpc(
      `progress:finalised:solana:${orderId}`,
      async () => readIsOrderFinalised(await getSolanaReads(chainId), orderId),
      { ttlMs: PROGRESS_TTL_MS }
    );
  }

  if (isTronChain(chainId)) {
    return getOrFetchRpc(
      `progress:finalised:tron:${orderId}`,
      async () => {
        // The settler is resolved from the order container so pre-rotation
        // (legacy) orders stay trackable.
        const status = await readOrderStatus(await getTronReads(), inputSettler, orderId);
        return status === OrderStatus_Claimed || status === OrderStatus_Refunded;
      },
      { ttlMs: PROGRESS_TTL_MS }
    );
  }

  const inputChainClient = getClient(chainId);

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
    const flattenedInputs = "originChainId" in order ? order.inputs : order.inputs[0]?.inputs;
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
  fillTransactions: Record<string, TxRef>
): Promise<FlowCheckState> {
  try {
    const intent = containerToIntent(orderContainer);
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
            // Validated against the OUTPUT chain: a Solana fill is base58, so
            // a 0x-only check would discard it here and the order could never
            // report as validated.
            if (!isValidTxRef(fillHash, output.chainId)) return false;
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
