import {
  BYTES32_ZERO,
  COMPACT,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  getClient,
  isHyperlaneOracle
} from "$lib/config";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { COMPACT_ABI } from "$lib/abi/compact";
import { hashStruct } from "viem";
import { compactTypes } from "@lifi/intent";
// `getOutputHash` is the MandateOutput identity hash (oracle‖settler‖chainId‖…) and
// carries no domain magic — that one is correct in the package. The FILL payload
// hash is NOT: see `fillPayload.ts`.
import { getOutputHash } from "@lifi/intent";
import { hashFillDescription } from "$lib/libraries/fillPayload";
import { bytes32ToAddress } from "@lifi/intent";
import { containerToIntent } from "$lib/utils/intent";
import { getOrFetchRpc } from "$lib/libraries/rpcCache";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { isTronChain } from "$lib/utils/chainType";
import { getFillDetails } from "$lib/libraries/fillEvent";
import { getTronReads } from "$lib/tron/client";
import { readIsOutputFilled, readIsProven, readOrderStatus } from "$lib/tron/reads";
import store from "$lib/state.svelte";
import {
  hyperlaneSubmissionKey,
  type HyperlaneSubmission
} from "$lib/libraries/hyperlaneSubmission";

const PROGRESS_TTL_MS = 30_000;
const OrderStatus_Claimed = 2;
const OrderStatus_Refunded = 3;

/**
 * Terminal state of an input chain. `Claimed` and `Refunded` both end the order, but
 * they are NOT the same outcome: a refund after a solver has already filled means the
 * solver paid out and got nothing back. With an asynchronous relay (Hyperlane) that is
 * a real risk, so the two are carried separately instead of being collapsed into a
 * single "finalised" boolean.
 */
export type TerminalStatus = "pending" | "claimed" | "refunded";

/**
 * Where a Hyperlane order sits in its (three-step, not two-step) attestation dance.
 *
 *  - `none`            not a Hyperlane order, or not filled yet.
 *  - `awaitingSubmit`  filled, but no `submit` is on record: nothing has been dispatched
 *                      (or the dispatch failed). NOTHING is relaying yet.
 *  - `awaitingRelayer` a submit is on record and the interchain gas is paid; a Hyperlane
 *                      relayer still has to deliver `handle` on the input chain.
 *  - `validated`       the attestation landed; `finalise` is possible.
 *
 * The distinction matters because the first two look identical on-chain from the input
 * chain's side, and only the second one is actually out of the app's hands.
 */
export type HyperlaneRelayStage = "none" | "awaitingSubmit" | "awaitingRelayer" | "validated";

export type FlowCheckState = {
  allFilled: boolean;
  allValidated: boolean;
  /** Every input chain reached a terminal state — claimed OR refunded. */
  allFinalised: boolean;
  /** Every input chain was claimed. This is the success condition. */
  allClaimed: boolean;
  /** At least one input chain refunded. A failure, even though it is terminal. */
  anyRefunded: boolean;
  /** Hyperlane only. See `HyperlaneRelayStage`. */
  hyperlaneStage: HyperlaneRelayStage;
  /**
   * Hyperlane only: a `submit` is on record and the attestation has not arrived. There
   * is no proof to fetch (unlike Polymer) — the wait is purely for a Hyperlane relayer
   * to deliver `handle` on the input chain. Derived from persisted submit evidence, NOT
   * from "the fill landed": before the solver has dispatched, nothing is relaying.
   */
  awaitingRelayer: boolean;
  /** Hyperlane only: filled, but nothing dispatched yet (or the dispatch failed). */
  awaitingSubmit: boolean;
};

export const EMPTY_FLOW_CHECKS: FlowCheckState = {
  allFilled: false,
  allValidated: false,
  allFinalised: false,
  allClaimed: false,
  anyRefunded: false,
  hyperlaneStage: "none",
  awaitingRelayer: false,
  awaitingSubmit: false
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
  const outputHash = getOutputHash(output);
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
  fillTransactionHash: `0x${string}`
) {
  const outputKey = getOutputStorageKey(output);

  // Solver and timestamp come from the OutputFilled event — the recorded
  // solver may be an override, not the transaction sender, and the recorded
  // timestamp is the exact value hashed into the attested payload.
  const { solver, timestamp } = await getFillDetails(orderId, output, fillTransactionHash);

  // Must be the MAGIC-TAGGED FillDescription hash. `@lifi/intent@0.2.1`'s
  // `encodeMandateOutput` omits the 4-byte FILL_MAGIC that the deployed settlers and
  // oracles hash, so proving with it never matched and this check never went true.
  const outputHash = hashFillDescription({
    solver,
    orderId,
    timestamp,
    output
  });

  const provenCacheKey = `progress:proven:${orderId}:${inputChain.toString()}:${outputKey}:${fillTransactionHash}`;
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

function toTerminalStatus(orderStatus: number): TerminalStatus {
  if (orderStatus === OrderStatus_Claimed) return "claimed";
  if (orderStatus === OrderStatus_Refunded) return "refunded";
  return "pending";
}

/**
 * Terminal status of one input chain. Deliberately returns which terminal state was
 * reached rather than a "finalised" boolean: a refund on an order the solver already
 * filled is a loss, not a success, and the UI has to be able to say so.
 */
export async function getInputChainTerminalStatus(
  chainId: bigint,
  container: OrderContainer
): Promise<TerminalStatus> {
  const { order, inputSettler } = container;
  const intent = containerToIntent(container);
  const orderId = intent.orderId();

  if (isTronChain(chainId)) {
    return getOrFetchRpc(
      `progress:terminal:tron:${orderId}`,
      async () => {
        // The settler is resolved from the order container so pre-rotation
        // (legacy) orders stay trackable.
        const status = await readOrderStatus(await getTronReads(), inputSettler, orderId);
        return toTerminalStatus(Number(status));
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
      `progress:terminal:escrow:${orderId}:${chainId.toString()}`,
      async () => {
        const orderStatus = await inputChainClient.readContract({
          address: inputSettler,
          abi: SETTLER_ESCROW_ABI,
          functionName: "orderStatus",
          args: [orderId]
        });
        return toTerminalStatus(Number(orderStatus));
      },
      { ttlMs: PROGRESS_TTL_MS }
    );
  }

  if (
    inputSettler === INPUT_SETTLER_COMPACT_LIFI ||
    inputSettler === MULTICHAIN_INPUT_SETTLER_COMPACT
  ) {
    const flattenedInputs = "originChainId" in order ? order.inputs : order.inputs[0]?.inputs;
    if (!flattenedInputs || flattenedInputs.length === 0) return "pending";

    return getOrFetchRpc(
      `progress:terminal:compact:${orderId}:${chainId.toString()}`,
      async () => {
        const [, allocator] = await inputChainClient.readContract({
          address: COMPACT,
          abi: COMPACT_ABI,
          functionName: "getLockDetails",
          args: [flattenedInputs[0][0]]
        });
        const nonceConsumed = await inputChainClient.readContract({
          address: COMPACT,
          abi: COMPACT_ABI,
          functionName: "hasConsumedAllocatorNonce",
          args: [order.nonce, allocator]
        });
        // The Compact only exposes "nonce spent", which cannot distinguish a claim
        // from a refund. Report it as claimed: refund on the compact path goes
        // through the sponsor letting the lock expire, not through a settler status.
        return nonceConsumed ? "claimed" : "pending";
      },
      { ttlMs: PROGRESS_TTL_MS }
    );
  }

  return "pending";
}

/**
 * True only if every (input chain, output) pair that needs a Hyperlane message has a
 * persisted submit record for it. Anything less means at least one message was never
 * dispatched, so the order is not "relaying".
 */
function allHyperlaneMessagesSubmitted(
  orderId: `0x${string}`,
  inputChains: bigint[],
  outputs: readonly MandateOutput[],
  submissions: Record<string, HyperlaneSubmission>
) {
  if (inputChains.length === 0 || outputs.length === 0) return false;
  return inputChains.every((inputChain) =>
    outputs.every(
      (output) =>
        !!submissions[hyperlaneSubmissionKey(orderId, inputChain, getOutputStorageKey(output))]
    )
  );
}

export async function getOrderProgressChecks(
  orderContainer: OrderContainer,
  fillTransactions: Record<string, `0x${string}`>,
  /**
   * Persisted Hyperlane submit evidence. Defaults to the store so existing call sites
   * (and the e2e specs) see the real, reload-surviving state; injectable for tests.
   */
  hyperlaneSubmissions: Record<string, HyperlaneSubmission> = store.hyperlaneSubmissions
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

    // Terminal status is checked as soon as the outputs are filled, NOT gated on
    // `allValidated`. A refund only becomes visible when validation has *not*
    // happened, so gating it on validation would hide the exact case that costs the
    // solver money: filled, then refunded because the attestation arrived too late.
    let terminalStatuses: TerminalStatus[] = [];
    if (allFilled && inputChains.length > 0) {
      terminalStatuses = await Promise.all(
        inputChains.map((chainId) => getInputChainTerminalStatus(chainId, orderContainer))
      );
    }
    const allFinalised =
      terminalStatuses.length > 0 && terminalStatuses.every((status) => status !== "pending");
    const allClaimed =
      terminalStatuses.length > 0 && terminalStatuses.every((status) => status === "claimed");
    const anyRefunded = terminalStatuses.some((status) => status === "refunded");

    // Hyperlane has no proof-fetch step, but it does have a dispatch step the solver
    // pays for. "Filled" therefore does NOT imply "relaying": only a persisted submit
    // record does. Without that distinction the UI claims a message is in flight before
    // the user has clicked anything — and keeps claiming it if the submit reverted.
    let hyperlaneStage: HyperlaneRelayStage = "none";
    if (isHyperlaneOracle(orderContainer.order.inputOracle)) {
      if (allValidated) {
        hyperlaneStage = "validated";
      } else if (allFilled && !allFinalised) {
        hyperlaneStage = allHyperlaneMessagesSubmitted(
          orderId,
          inputChains,
          outputs,
          hyperlaneSubmissions
        )
          ? "awaitingRelayer"
          : "awaitingSubmit";
      }
    }

    return {
      allFilled,
      allValidated,
      allFinalised,
      allClaimed,
      anyRefunded,
      hyperlaneStage,
      awaitingRelayer: hyperlaneStage === "awaitingRelayer",
      awaitingSubmit: hyperlaneStage === "awaitingSubmit"
    };
  } catch (error) {
    console.warn("progress checks failed", error);
    return { ...EMPTY_FLOW_CHECKS };
  }
}
