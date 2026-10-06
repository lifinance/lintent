import {
  BYTES32_ZERO,
  COMPACT,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  getClient,
  isStellarChain
} from "$lib/config";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { COMPACT_ABI } from "$lib/abi/compact";
import { hashStruct, keccak256 } from "viem";
import { bytes32ToAddress, compactTypes, getOutputHash } from "@lifi/intent";
import { containerToIntent } from "$lib/utils/intent";
import { getOrFetchRpc } from "$lib/libraries/rpcCache";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { getFillInfo } from "./fillInfo";
import { stellarFillRecord, stellarIsProven, stellarOrderStatus } from "./stellar";

const PROGRESS_TTL_MS = 30_000;
const OrderStatus_Claimed = 2;
const OrderStatus_Refunded = 3;
// The Soroban escrow's OrderStatus has no `None` variant.
const StellarOrderStatus_Claimed = 1;
const StellarOrderStatus_Refunded = 2;

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

export async function isOutputFilled(orderId: `0x${string}`, output: MandateOutput) {
  const outputKey = getOutputStorageKey(output);
  return getOrFetchRpc(
    `progress:filled:${orderId}:${outputKey}`,
    async () => {
      const outputHash = getOutputHash(output);
      if (isStellarChain(output.chainId))
        return (await stellarFillRecord(orderId, outputHash)) !== undefined;
      const result = await getClient(output.chainId).readContract({
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

export async function isOutputValidatedOnChain(
  orderId: `0x${string}`,
  inputChain: bigint,
  orderContainer: OrderContainer,
  output: MandateOutput,
  fillTransactionHash: `0x${string}`
) {
  const outputKey = getOutputStorageKey(output);
  const { payload } = await getFillInfo({ orderId, output, fillTransactionHash });
  const payloadHash = keccak256(payload);
  const { inputOracle } = orderContainer.order;

  return getOrFetchRpc(
    `progress:proven:${orderId}:${inputChain.toString()}:${outputKey}:${fillTransactionHash}`,
    async () => {
      if (isStellarChain(inputChain))
        return stellarIsProven(
          inputOracle,
          output.chainId,
          output.oracle,
          output.settler,
          payloadHash
        );
      // isProven is BaseInputOracle's, shared by the Polymer and Axelar oracles.
      return getClient(inputChain).readContract({
        address: inputOracle,
        abi: POLYMER_ORACLE_ABI,
        functionName: "isProven",
        args: [output.chainId, output.oracle, output.settler, payloadHash]
      });
    },
    { ttlMs: PROGRESS_TTL_MS }
  );
}

export async function isInputChainFinalised(chainId: bigint, container: OrderContainer) {
  const { order, inputSettler } = container;
  const intent = containerToIntent(container);
  const orderId = intent.orderId();

  if (isStellarChain(chainId)) {
    return getOrFetchRpc(
      `progress:finalised:stellar:${orderId}`,
      async () => {
        const status = await stellarOrderStatus(orderId);
        return status === StellarOrderStatus_Claimed || status === StellarOrderStatus_Refunded;
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
  fillTransactions: Record<string, `0x${string}`>
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
