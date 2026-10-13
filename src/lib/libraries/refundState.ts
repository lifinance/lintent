// Pure refund policy: fast-rail selection and the view state machine. No I/O —
// everything chain-derived arrives as a `RefundSnapshot` (refundReads.ts).
// Ported and adapted from ../intents-auto-refund core/eligibility.ts
// (classifyOrder, fastPathTiming, fastPathRail) and fast-refund.ts
// (selectViableOutput, notFilledMintWindowSkip, canStartWork).

import {
  addressToBytes32,
  getNotFilledDescriptionHash,
  SOLANA_OUTPUT_SETTLER_PDA,
  SOLANA_POLYMER_ORACLE_PROGRAM
} from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import {
  chainMetaById,
  COIN_FILLER,
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_ORACLE,
  type Verifier
} from "$lib/config";
import { getChainType, isSolanaChain, type ChainType } from "$lib/utils/chainType";
import { polymerOraclesFor } from "./polymerReceive";
import { oracleProviderFor } from "./oracleRoute";
import type { WormholePublication } from "./wormholeProof";
import {
  REFUND_CHAIN_IDS,
  type EscrowRefundOrder,
  type RefundOrder,
  type UnsupportedReason
} from "./refundLookup";
import {
  MINT_WINDOW_MARGIN_SECS,
  NOT_FILLED_WINDOW_SECS,
  type NotFilledLocalAttestation
} from "$lib/solana/nonFill";

export { MINT_WINDOW_MARGIN_SECS, NOT_FILLED_WINDOW_SECS };
export type { NotFilledLocalAttestation };

/** Fast refund must leave this much time before `expires` (auto-refund `minRemainingSecs`). */
export const FAST_MIN_REMAINING_SECS = 7200;
/** Solana→Solana slow refund waits this long past `expires` (auto-refund `samechainRefundGraceSecs`). */
export const SOLANA_SAMECHAIN_REFUND_GRACE_SECS = 900;

export type EscrowState = "none" | "deposited" | "claimed" | "refunded" | "closed";
export type OutputFill = "filled" | "unfilled" | "unknown";
export type ProofSource =
  | {
      kind: "evm";
      chainId: number;
      blockNumber: bigint;
      logIndex: number;
      txHash: `0x${string}`;
    }
  | { kind: "solana"; signature: string }
  | { kind: "wormhole"; publication: WormholePublication };
export type FastRail = {
  provider: Verifier;
  outputIndex: number;
  output: MandateOutput;
  destKind: ChainType;
  notFilledHash: `0x${string}`;
};
export type FastUnavailableReason =
  | "same-chain"
  | "solana-to-solana"
  | "unsupported-input-oracle"
  | "wormhole-route-unavailable"
  | "wormhole-publication-unavailable"
  | "no-provable-output"
  | "legacy-settler"
  | "chain-map-missing"
  | "settler-no-code"
  | "solana-refund-too-large"
  | "solana-window-elapsed"
  | "solana-attestation-consumed"
  | "solana-attestation-legacy"
  | "expiry-buffer";
export type FastProgress = {
  rail: FastRail;
  attested: boolean;
  source: ProofSource | null;
  solanaLocal?: NotFilledLocalAttestation;
};
export type RefundSnapshot = {
  escrow: EscrowState;
  /** Per output; [] when the escrow is not deposited. */
  outputs: OutputFill[];
  /** null when not read (escrow not deposited, or an output blocks refunds). */
  fast: FastProgress | { unavailable: FastUnavailableReason } | null;
};

export type FastStep = "record" | "prove" | "refund";
export type RefundView =
  | { kind: "unsupported"; reason: UnsupportedReason }
  | { kind: "not-opened" }
  | { kind: "refunded"; refundTx: string | null }
  | { kind: "claimed" }
  | { kind: "settled" }
  | { kind: "filled"; outputIndexes: number[] }
  | { kind: "fill-unverifiable"; outputIndexes: number[] }
  | { kind: "slow" }
  | { kind: "waiting-expiry"; slowAt: number; fastReason: FastUnavailableReason | null }
  | { kind: "waiting-fill-deadline"; fastAt: number | null; slowAt: number }
  | { kind: "fast"; step: FastStep; rail: FastRail; finishOnly: boolean; slowAt: number };

/** Display name for any chain id, including ones lintent doesn't register. */
export function chainLabel(chainId: number | bigint): string {
  return chainMetaById[Number(chainId)]?.name ?? `chain ${chainId.toString()}`;
}

const lower = (value: string) => value.toLowerCase();

/**
 * Seconds after `expires` before the slow refund is offered. Solana origin with
 * a Solana output waits out the same-chain grace auto-refund applies.
 */
export function slowRefundGraceSecs(order: EscrowRefundOrder): number {
  return isSolanaChain(order.order.originChainId) &&
    order.order.outputs.some((output) => isSolanaChain(output.chainId))
    ? SOLANA_SAMECHAIN_REFUND_GRACE_SECS
    : 0;
}

/** Static fast-rail selection (plan §5.3): which output a non-fill proof can refund against. */
export function selectFastRail(
  order: EscrowRefundOrder
): FastRail | { reason: FastUnavailableReason } {
  const { order: o, orderId } = order;
  const origin = o.originChainId;
  const originKind = getChainType(origin);
  if (order.legacySettler) return { reason: "legacy-settler" };
  if (o.outputs.every((output) => BigInt(output.chainId) === BigInt(origin)))
    return { reason: "same-chain" };
  if (originKind === "solana" && o.outputs.some((output) => isSolanaChain(output.chainId))) {
    return { reason: "solana-to-solana" };
  }
  const provider = oracleProviderFor(origin, o.inputOracle);
  if (!provider) return { reason: "unsupported-input-oracle" };
  const inputOracleBytes32 = lower(addressToBytes32(o.inputOracle));
  const matchesProvider = (output: MandateOutput) => {
    if (
      BigInt(output.chainId) === BigInt(origin) ||
      !REFUND_CHAIN_IDS.includes(Number(output.chainId))
    ) {
      return false;
    }
    const oracle = lower(output.oracle);
    if (provider === "wormhole") {
      const candidate = WORMHOLE_ORACLE[Number(output.chainId)];
      const nativeId = WORMHOLE_CHAIN_IDS[Number(output.chainId)];
      const originMeta = chainMetaById[Number(origin)];
      const outputMeta = chainMetaById[Number(output.chainId)];
      if (
        !candidate ||
        !nativeId ||
        !originMeta ||
        !outputMeta ||
        originMeta.testnet !== outputMeta.testnet
      )
        return false;
      const settler = isSolanaChain(output.chainId)
        ? SOLANA_OUTPUT_SETTLER_PDA
        : addressToBytes32(COIN_FILLER);
      return (
        oracle === lower(addressToBytes32(candidate)) && lower(output.settler) === lower(settler)
      );
    }
    if (isSolanaChain(output.chainId)) {
      return (
        oracle === lower(SOLANA_POLYMER_ORACLE_PROGRAM) &&
        lower(output.settler) === lower(SOLANA_OUTPUT_SETTLER_PDA)
      );
    }
    if (originKind === "solana") {
      return [...polymerOraclesFor(output.chainId)].some(
        (address) => lower(addressToBytes32(address as `0x${string}`)) === oracle
      );
    }
    return oracle === inputOracleBytes32;
  };
  if (
    provider === "wormhole" &&
    o.outputs.some(
      (output) => BigInt(output.chainId) !== BigInt(origin) && !matchesProvider(output)
    )
  ) {
    return { reason: "no-provable-output" };
  }
  const outputIndex = o.outputs.findIndex(matchesProvider);
  if (outputIndex === -1) return { reason: "no-provable-output" };
  const output = o.outputs[outputIndex]!;
  return {
    provider,
    outputIndex,
    output,
    destKind: getChainType(output.chainId),
    notFilledHash: getNotFilledDescriptionHash({ orderId, fillDeadline: o.fillDeadline, output })
  };
}

const API_DELIVERED_STATUSES: ReadonlySet<string> = new Set(["Delivered", "Settled"]);

/**
 * The page's state machine (plan §4.2). First match wins; precedence mirrors
 * auto-refund `classifyOrder`: terminal escrow states, then any sign of a fill
 * (a refund would turn the solver's payment into a loss), then slow, then fast.
 */
export function deriveRefundView(
  order: RefundOrder,
  snapshot: RefundSnapshot | null,
  nowSecs: number
): RefundView | null {
  if (order.unsupported) return { kind: "unsupported", reason: order.unsupported };
  if (!order.order || !snapshot) return null;
  const escrowOrder = order as EscrowRefundOrder;
  const { meta } = order;
  const { expires, fillDeadline } = escrowOrder.order;
  const { escrow, outputs, fast } = snapshot;

  if (escrow === "none") return { kind: "not-opened" };
  if (escrow === "refunded" || (escrow === "closed" && meta.refundTxHash)) {
    return { kind: "refunded", refundTx: meta.refundTxHash };
  }
  if (escrow === "claimed" || (escrow === "closed" && meta.orderSettledTxHash)) {
    return { kind: "claimed" };
  }
  if (escrow === "closed") return { kind: "settled" };

  const indexesWhere = (state: OutputFill) =>
    outputs.flatMap((fill, index) => (fill === state ? [index] : []));
  const filled = indexesWhere("filled");
  if (
    filled.length > 0 ||
    meta.orderDeliveredTxHash ||
    meta.orderSettledTxHash ||
    (meta.orderStatus !== null && API_DELIVERED_STATUSES.has(meta.orderStatus))
  ) {
    return { kind: "filled", outputIndexes: filled };
  }
  const unknown = indexesWhere("unknown");
  if (outputs.length !== escrowOrder.order.outputs.length) {
    return {
      kind: "fill-unverifiable",
      outputIndexes: escrowOrder.order.outputs.map((_, index) => index)
    };
  }
  const incomplete = escrowOrder.order.outputs.flatMap((_, index) =>
    outputs[index] === "unfilled" || outputs[index] === "filled" ? [] : [index]
  );
  if (unknown.length > 0 || incomplete.length > 0) {
    return { kind: "fill-unverifiable", outputIndexes: [...new Set([...unknown, ...incomplete])] };
  }

  const grace = slowRefundGraceSecs(escrowOrder);
  const slowAt = expires + grace;
  if (nowSecs > slowAt) return { kind: "slow" };
  if (nowSecs > expires) {
    return { kind: "waiting-expiry", slowAt, fastReason: "solana-to-solana" };
  }
  if (nowSecs <= fillDeadline) {
    const fastAt = fast && !("unavailable" in fast) ? fillDeadline : null;
    return { kind: "waiting-fill-deadline", fastAt, slowAt };
  }
  if (!fast) return { kind: "waiting-expiry", slowAt, fastReason: null };
  if ("unavailable" in fast) {
    return { kind: "waiting-expiry", slowAt, fastReason: fast.unavailable };
  }

  const remaining = expires - nowSecs;
  const fastView = (step: FastStep) =>
    ({
      kind: "fast",
      step,
      rail: fast.rail,
      finishOnly: remaining <= FAST_MIN_REMAINING_SECS,
      slowAt
    }) as const;
  if (fast.attested) return fastView("refund");
  if (remaining <= FAST_MIN_REMAINING_SECS) {
    return { kind: "waiting-expiry", slowAt, fastReason: "expiry-buffer" };
  }
  if (fast.source !== null) return fastView("prove");
  if (fast.rail.destKind === "solana") {
    const local = fast.solanaLocal?.kind;
    if (local === "consumed") {
      return { kind: "waiting-expiry", slowAt, fastReason: "solana-attestation-consumed" };
    }
    if (local === "legacy") {
      return { kind: "waiting-expiry", slowAt, fastReason: "solana-attestation-legacy" };
    }
    if (
      local === "absent" &&
      nowSecs + MINT_WINDOW_MARGIN_SECS > fillDeadline + NOT_FILLED_WINDOW_SECS
    ) {
      return { kind: "waiting-expiry", slowAt, fastReason: "solana-window-elapsed" };
    }
  }
  return fastView("record");
}

/**
 * Whether a decoded `OutputNotFilled` is for exactly this output and deadline.
 * Both are non-indexed and caller-supplied — anyone can emit the event for an
 * order id with a fabricated deadline or output — so every field is compared.
 * Port of auto-refund adapters/evm/fast-reads.ts `matches()`.
 */
export function matchesNotFilledLog(
  args: { output: MandateOutput; fillDeadline: number },
  output: MandateOutput,
  fillDeadline: number
): boolean {
  const got = args.output;
  return (
    args.fillDeadline === fillDeadline &&
    lower(got.oracle) === lower(output.oracle) &&
    lower(got.settler) === lower(output.settler) &&
    got.chainId === output.chainId &&
    lower(got.token) === lower(output.token) &&
    got.amount === output.amount &&
    lower(got.recipient) === lower(output.recipient) &&
    lower(got.callbackData) === lower(output.callbackData) &&
    lower(got.context) === lower(output.context)
  );
}

export type SpendMode = "slow" | "record" | "prove" | "fast";

/**
 * Whether a spend may proceed on chain state read immediately before it
 * (plan §5.5, auto-refund re-checks before every spend). Every fast step runs
 * this right before signing, so time spent polling Polymer or waiting on a
 * wallet can't carry a stale "eligible" past a fill, an expiry or the buffer.
 *
 * `"already-proven"`: a third party delivered the non-fill proof first. The
 * record and prove steps are then no-ops, not failures.
 */
export function preSpendVerdict(
  order: EscrowRefundOrder,
  mode: SpendMode,
  state: { escrow: EscrowState; outputs: OutputFill[]; attested: boolean },
  nowSecs: number
): "go" | "already-proven" | { blocked: string } {
  const { expires, fillDeadline } = order.order;
  if (state.escrow !== "deposited") {
    return { blocked: "The order is no longer open. Refreshing…" };
  }
  if (
    order.meta.orderDeliveredTxHash ||
    order.meta.orderSettledTxHash ||
    order.meta.orderStatus === "Delivered" ||
    order.meta.orderStatus === "Settled"
  ) {
    return { blocked: "The order service reports this order as delivered. Refund isn't possible." };
  }
  if (state.outputs.includes("filled")) {
    return { blocked: "An output was filled. Refund isn't possible." };
  }
  if (state.outputs.includes("unknown")) {
    return { blocked: "Can't verify every output from this page. Refund isn't possible here." };
  }
  if (
    state.outputs.length !== order.order.outputs.length ||
    order.order.outputs.some((_, index) => state.outputs[index] !== "unfilled")
  ) {
    return { blocked: "Can't verify every output from this page. Refund isn't possible here." };
  }
  if (mode === "slow") {
    if (nowSecs <= expires + slowRefundGraceSecs(order)) {
      return { blocked: "The order hasn't passed its refund expiry and grace period yet." };
    }
    return "go";
  }
  if (mode === "fast") {
    if (!state.attested) return { blocked: "The origin oracle has no non-fill proof yet." };
    if (nowSecs >= expires) {
      return { blocked: "The order has expired. Use the regular refund instead." };
    }
    return "go";
  }
  if (state.attested) return "already-proven";
  if (expires - nowSecs <= FAST_MIN_REMAINING_SECS) {
    return { blocked: "Too close to expiry to start a fast refund." };
  }
  if (mode === "record" && nowSecs <= fillDeadline) {
    return { blocked: "The destination hasn't passed the fill deadline yet. Retry in a minute." };
  }
  return "go";
}
