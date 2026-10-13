// Chain reads behind the refund page: escrow state, output fills, fast-rail
// viability, and resume detection (attested? proof source located?). Every
// fast step is re-derived from here on each load, so a reload, another device
// or a third party finishing a step all land on the right next action.

import {
  bytes32ToAddress,
  bytes32ToSolanaBase58,
  encodeNotFilledDescription,
  type StandardSolana
} from "@lifi/intent";
import { getAbiItem, numberToHex, parseEventLogs, type Log } from "viem";
import { getClient } from "$lib/config";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { WORMHOLE_ORACLE_ABI } from "$lib/abi/wormholeoracle";
import { getChainType } from "$lib/utils/chainType";
import { getSolanaReads } from "$lib/solana/client";
import {
  findNotFilledRecordSignature,
  isNotFilledRecordTx,
  readChainMappingCanonicalId,
  readIsOrderFinalised,
  readIsOrderOpen,
  readIsProvenOnSolana,
  readNotFilledLocalAttestation
} from "$lib/solana/reads";
import {
  buildCreateAtaIdempotentInstruction,
  buildRefundOnNonFillInstruction,
  estimateLegacyTxSize
} from "$lib/solana/nonFill";
import {
  attestationPda,
  bytes32ToPubkey,
  polymerOraclePda,
  TOKEN_PROGRAM_ID
} from "$lib/solana/pda";
import { getTronReads } from "$lib/tron/client";
import { readIsProven, readOrderStatus, readReverseChainIdMap } from "$lib/tron/reads";
import { isOutputFilled } from "./fillStatus";
import { loadBreadcrumb, saveBreadcrumb } from "./refundBreadcrumbs";
import { REFUND_CHAIN_IDS, type EscrowRefundOrder } from "./refundLookup";
import { checkWormholeRoute } from "./oracleRoute";
import { findWormholePublication } from "./wormholeProof";
import { MINT_WINDOW_MARGIN_SECS, NOT_FILLED_WINDOW_SECS } from "$lib/solana/nonFill";
import {
  chainLabel,
  FAST_MIN_REMAINING_SECS,
  matchesNotFilledLog,
  preSpendVerdict,
  selectFastRail,
  type EscrowState,
  type FastProgress,
  type FastRail,
  type FastUnavailableReason,
  type OutputFill,
  type ProofSource,
  type RefundSnapshot,
  type SpendMode
} from "./refundState";

/** A chain read failed; the UI keeps the last snapshot and offers a retry. */
export class RefundReadError extends Error {
  constructor(
    readonly chain: string,
    cause: unknown
  ) {
    super(`Couldn't read ${chain}. Retry.`, { cause });
    this.name = "RefundReadError";
  }
}

/** A pre-spend re-check refused the action; `message` is user-facing copy. */
export class RefundActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundActionError";
  }
}

async function readOn<T>(chainId: number | bigint, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new RefundReadError(chainLabel(chainId), error);
  }
}

const lower = (value: string) => value.toLowerCase();

// InputSettlerEscrow OrderStatus enum.
const ESCROW_BY_STATUS: Record<number, EscrowState> = {
  0: "none",
  1: "deposited",
  2: "claimed",
  3: "refunded"
};

export function readEscrowState(order: EscrowRefundOrder): Promise<EscrowState> {
  const origin = order.order.originChainId;
  return readOn(origin, async () => {
    switch (getChainType(origin)) {
      case "solana": {
        // No status enum on Solana: `finalise` and `refund` both close the
        // order context, so a closed context is "claimed or refunded".
        const reads = await getSolanaReads(origin);
        if (await readIsOrderOpen(reads, order.orderId)) return "deposited";
        return (await readIsOrderFinalised(reads, order.orderId)) ? "closed" : "none";
      }
      case "tron": {
        const status = await readOrderStatus(
          await getTronReads(),
          order.container.inputSettler,
          order.orderId
        );
        return escrowFromStatus(status);
      }
      case "evm": {
        const status = await getClient(origin).readContract({
          address: order.container.inputSettler,
          abi: SETTLER_ESCROW_ABI,
          functionName: "orderStatus",
          args: [order.orderId]
        });
        return escrowFromStatus(Number(status));
      }
    }
  });
}

function escrowFromStatus(status: number): EscrowState {
  const state = ESCROW_BY_STATUS[status];
  if (!state) throw new Error(`Unknown escrow order status ${status}`);
  return state;
}

/** Fill state per output; "unknown" for outputs on chains this page can't read. */
export function readOutputFills(order: EscrowRefundOrder): Promise<OutputFill[]> {
  return Promise.all(
    order.order.outputs.map(async (output): Promise<OutputFill> => {
      if (!REFUND_CHAIN_IDS.includes(Number(output.chainId))) return "unknown";
      const filled = await readOn(output.chainId, () => isOutputFilled(order.orderId, output));
      return filled ? "filled" : "unfilled";
    })
  );
}

/** Whether the origin oracle already holds the non-fill attestation for the rail. */
export function readAttested(order: EscrowRefundOrder, rail: FastRail): Promise<boolean> {
  const { originChainId: origin, inputOracle } = order.order;
  const { output, notFilledHash } = rail;
  return readOn(origin, async () => {
    switch (getChainType(origin)) {
      case "solana":
        return readIsProvenOnSolana(await getSolanaReads(origin), {
          inputOracle,
          output,
          payloadHash: notFilledHash
        });
      case "tron":
        return readIsProven(
          await getTronReads(),
          inputOracle,
          output.chainId,
          output.oracle,
          output.settler,
          notFilledHash
        );
      case "evm":
        return getClient(origin).readContract({
          address: inputOracle,
          abi: rail.provider === "wormhole" ? WORMHOLE_ORACLE_ABI : POLYMER_ORACLE_ABI,
          functionName: "isProven",
          args: [output.chainId, output.oracle, output.settler, notFilledHash]
        });
    }
  });
}

/** Largest legacy transaction Solana accepts. */
const SOLANA_TX_LIMIT_BYTES = 1232;

// Retain immutable Polymer successes only; Wormhole's shared route checker
// scopes its own success cache to the complete deployment and RPC identities.
const railCheckCache = new Map<string, Promise<true | { reason: FastUnavailableReason }>>();

/**
 * On-chain viability of the rail (plan §5.4), checked before any spend so a
 * fast refund that would end in a revert is never started.
 */
export function checkFastRailOnChain(
  order: EscrowRefundOrder,
  rail: FastRail
): Promise<true | { reason: FastUnavailableReason }> {
  if (rail.provider === "wormhole") return runRailCheck(order, rail);
  const key = `${order.orderId}:${order.order.originChainId}:${order.order.inputOracle}:${rail.outputIndex}:${rail.output.chainId}:${rail.output.oracle}:${rail.output.settler}`;
  let pending = railCheckCache.get(key);
  if (!pending) {
    pending = runRailCheck(order, rail);
    railCheckCache.set(key, pending);
    pending.then(
      (result) => {
        if (result !== true) railCheckCache.delete(key);
      },
      () => railCheckCache.delete(key)
    );
  }
  return pending;
}

async function runRailCheck(
  order: EscrowRefundOrder,
  rail: FastRail
): Promise<true | { reason: FastUnavailableReason }> {
  const { originChainId: origin, inputOracle } = order.order;
  const { output } = rail;
  if (rail.provider === "wormhole") {
    const readiness = await checkWormholeRoute(origin, inputOracle, output);
    if (!readiness.ready) return { reason: "wormhole-route-unavailable" };
    if (
      getChainType(origin) === "solana" &&
      (await estimateSolanaRefundSize(order, rail)) > SOLANA_TX_LIMIT_BYTES
    ) {
      return { reason: "solana-refund-too-large" };
    }
    return true;
  }
  const originCheck = await readOn(origin, async () => {
    switch (getChainType(origin)) {
      case "evm": {
        // A zero (or missing) mapping makes the oracle revert ZeroValue() on receive.
        try {
          const mapped = await getClient(origin).readContract({
            address: inputOracle,
            abi: POLYMER_ORACLE_ABI,
            functionName: "reverseChainIdMap",
            args: [output.chainId]
          });
          return mapped !== 0n;
        } catch {
          return false;
        }
      }
      case "tron": {
        try {
          const mapped = await readReverseChainIdMap(
            await getTronReads(),
            inputOracle,
            output.chainId
          );
          return mapped !== 0n;
        } catch {
          return false;
        }
      }
      case "solana": {
        const reads = await getSolanaReads(origin);
        // The Polymer protocol id is the identity for EVM destinations — the
        // same assumption `receiveProof` makes.
        return (
          (await readChainMappingCanonicalId(
            reads,
            polymerOraclePda().toBase58(),
            output.chainId
          )) === output.chainId
        );
      }
    }
  });
  if (!originCheck) return { reason: "chain-map-missing" };

  if (getChainType(origin) === "solana") {
    const size = await estimateSolanaRefundSize(order, rail);
    if (size > SOLANA_TX_LIMIT_BYTES) return { reason: "solana-refund-too-large" };
  }

  if (rail.destKind === "evm") {
    const code = await readOn(output.chainId, () =>
      getClient(output.chainId).getCode({ address: bytes32ToAddress(output.settler) })
    );
    if (!code || code === "0x") return { reason: "settler-no-code" };
  }
  return true;
}

/**
 * Worst-case size of `[createAtaIdempotent, refund_on_non_fill]`. The order
 * (callback data, context) is what varies; placeholder signer and sponsor keys
 * are chosen distinct from every other key so nothing dedups.
 */
async function estimateSolanaRefundSize(order: EscrowRefundOrder, rail: FastRail) {
  const solanaOrder = order.order as StandardSolana;
  const [input] = solanaOrder.inputs;
  if (!input) throw new Error("A Solana order must have exactly one input");
  const mint = bytes32ToSolanaBase58(numberToHex(input[0], { size: 32 }));
  const user = bytes32ToSolanaBase58(solanaOrder.user);
  const signer = bytes32ToSolanaBase58(`0x${"01".repeat(32)}`);
  const sponsor = bytes32ToSolanaBase58(`0x${"02".repeat(32)}`);
  const attestation = attestationPda(
    bytes32ToPubkey(solanaOrder.inputOracle),
    rail.output.chainId,
    rail.output.oracle,
    rail.output.settler,
    rail.notFilledHash
  ).toBase58();
  return estimateLegacyTxSize(
    [
      buildCreateAtaIdempotentInstruction({
        payer: signer,
        owner: user,
        mint,
        tokenProgramId: TOKEN_PROGRAM_ID
      }),
      buildRefundOnNonFillInstruction({
        signer,
        order: solanaOrder,
        orderId: order.orderId,
        sponsor,
        tokenProgramId: TOKEN_PROGRAM_ID,
        outputIndex: rail.outputIndex,
        attestation
      })
    ],
    signer
  );
}

const NOT_FILLED_SCAN_BLOCKS = 50_000n;
const NOT_FILLED_SCAN_CHUNK = 10_000n;
const NOT_FILLED_MIN_CHUNK = 1_000n;
const OUTPUT_NOT_FILLED_EVENT = getAbiItem({ abi: COIN_FILLER_ABI, name: "OutputNotFilled" });

// Highest block already scanned without a match, per rail, so the 30s refresh
// only scans new blocks instead of re-reading the whole window.
const scannedThrough = new Map<string, bigint>();

/**
 * The `OutputNotFilled` log for the rail on an EVM or Tron destination, as a
 * Polymer proof source. Tries the hinted transaction first, then scans recent
 * blocks newest-first. Null when not found or the RPC can't be scanned — the
 * user then re-emits, which is harmless.
 */
export async function locateNotFilledLog(
  order: EscrowRefundOrder,
  rail: FastRail,
  hintTxHash?: `0x${string}`
): Promise<ProofSource | null> {
  const { output } = rail;
  const chainId = Number(output.chainId);
  const settler = lower(bytes32ToAddress(output.settler));
  const fillDeadline = order.order.fillDeadline;
  const client = getClient(chainId);
  const toSource = (log: Log<bigint, number, false>): ProofSource => ({
    kind: "evm",
    chainId,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    txHash: log.transactionHash
  });
  const matching = (logs: Log<bigint, number, false>[]) =>
    parseEventLogs({ abi: COIN_FILLER_ABI, eventName: "OutputNotFilled", logs }).find(
      (log) =>
        lower(log.address) === settler &&
        lower(log.args.orderId) === order.orderId &&
        matchesNotFilledLog(log.args, output, fillDeadline)
    );

  if (hintTxHash) {
    try {
      // Fresh from RPC: Polymer needs the block-global log index.
      const receipt = await client.getTransactionReceipt({ hash: hintTxHash });
      const log = receipt.status === "success" ? matching(receipt.logs) : undefined;
      if (log) return toSource(log);
    } catch {
      // Not indexed yet or wrong chain; fall through to the scan.
    }
  }

  try {
    const key = `${order.orderId}:${rail.outputIndex}`;
    const latest = await client.getBlockNumber();
    const windowFloor = latest > NOT_FILLED_SCAN_BLOCKS ? latest - NOT_FILLED_SCAN_BLOCKS : 0n;
    const already = scannedThrough.get(key);
    const floor = already !== undefined && already + 1n > windowFloor ? already + 1n : windowFloor;
    let toBlock = latest;
    let chunk = NOT_FILLED_SCAN_CHUNK;
    while (toBlock >= floor) {
      const fromBlock = toBlock - chunk + 1n > floor ? toBlock - chunk + 1n : floor;
      try {
        const logs = await client.getLogs({
          address: settler as `0x${string}`,
          event: OUTPUT_NOT_FILLED_EVENT,
          args: { orderId: order.orderId },
          fromBlock,
          toBlock
        });
        const log = matching(logs as Log<bigint, number, false>[]);
        if (log) {
          saveBreadcrumb(order.orderId, rail.outputIndex, { emitTxHash: log.transactionHash });
          return toSource(log);
        }
        toBlock = fromBlock - 1n;
      } catch {
        // Providers cap getLogs ranges; halve and retry the same window.
        chunk /= 2n;
        if (chunk < NOT_FILLED_MIN_CHUNK) return null;
      }
    }
    scannedThrough.set(key, latest);
    return null;
  } catch {
    return null;
  }
}

/** The Solana `attest_not_filled`/`submit_consume` transaction for the rail, as a proof source. */
export async function locateSolanaRecord(
  order: EscrowRefundOrder,
  rail: FastRail,
  hintSignature?: string
): Promise<ProofSource | null> {
  const args = {
    orderId: order.orderId,
    output: rail.output,
    fillDeadline: order.order.fillDeadline
  };
  return readOn(rail.output.chainId, async () => {
    const reads = await getSolanaReads(rail.output.chainId);
    // The hint comes from localStorage: a malformed or stale value must fall
    // through to history discovery, not fail every refresh.
    if (
      hintSignature &&
      (await isNotFilledRecordTx(reads, hintSignature, args).catch(() => false))
    ) {
      return { kind: "solana", signature: hintSignature };
    }
    const found = await findNotFilledRecordSignature(reads, args);
    if (!found) return null;
    saveBreadcrumb(order.orderId, rail.outputIndex, { recordSignature: found });
    return { kind: "solana", signature: found };
  });
}

/**
 * Where the fast refund stands for this rail (plan §7.1). Proof-source
 * discovery is skipped when the view can't use it (attested, before the fill
 * deadline, or inside the expiry buffer) — it is the expensive part.
 */
async function readFastProgress(
  order: EscrowRefundOrder,
  nowSecs: number
): Promise<RefundSnapshot["fast"]> {
  const rail = selectFastRail(order);
  if ("reason" in rail) return { unavailable: rail.reason };
  // A proof delivered by anyone is sufficient to finish; an unavailable
  // destination RPC or consumed publication must not send us back to publish.
  const attested = await readAttested(order, rail);
  const progress: FastProgress = { rail, attested, source: null };
  const { fillDeadline, expires } = order.order;
  if (attested || nowSecs <= fillDeadline || expires - nowSecs <= FAST_MIN_REMAINING_SECS) {
    return progress;
  }
  const viable = await checkFastRailOnChain(order, rail);
  if (viable !== true) return { unavailable: viable.reason };

  if (rail.provider === "wormhole") {
    try {
      const publication = await findWormholePublication(rail.output, {
        application: rail.output.settler,
        payload: encodeNotFilledDescription({
          orderId: order.orderId,
          output: rail.output,
          fillDeadline
        })
      });
      if (publication) {
        progress.source = { kind: "wormhole", publication };
        return progress;
      }
    } catch {
      // Failed discovery/Scan is not proof that publication never happened.
      return { unavailable: "wormhole-publication-unavailable" };
    }
    if (rail.destKind === "solana") {
      const unavailable = await readSolanaLocalProgress(order, progress, nowSecs);
      if (unavailable) return { unavailable };
    }
    return progress;
  }

  const crumb = loadBreadcrumb(order.orderId, rail.outputIndex);
  if (rail.destKind === "solana") {
    progress.source = await locateSolanaRecord(order, rail, crumb?.recordSignature);
    if (!progress.source) {
      const unavailable = await readSolanaLocalProgress(order, progress, nowSecs);
      if (unavailable) return { unavailable };
    }
  } else {
    progress.source = await locateNotFilledLog(order, rail, crumb?.emitTxHash);
  }
  return progress;
}

/** Generic output.oracle consumer; use the destination's fresh finalized clock. */
async function readSolanaLocalProgress(
  order: EscrowRefundOrder,
  progress: FastProgress,
  nowSecs: number
): Promise<FastUnavailableReason | undefined> {
  return readOn(progress.rail.output.chainId, async () => {
    const reads = await getSolanaReads(progress.rail.output.chainId);
    const fillDeadline = order.order.fillDeadline;
    const local = await readNotFilledLocalAttestation(reads, {
      orderId: order.orderId,
      output: progress.rail.output,
      fillDeadline
    });
    progress.solanaLocal = local;
    if (local.kind === "consumed") return "solana-attestation-consumed";
    if (local.kind === "legacy") return "solana-attestation-legacy";
    const chainTime = await reads.getFinalizedBlockTime();
    if (!Number.isFinite(chainTime) || nowSecs - chainTime > MINT_WINDOW_MARGIN_SECS) {
      throw new Error("Solana finalized time is unavailable. Retry.");
    }
    if (chainTime <= fillDeadline) {
      throw new Error("Solana hasn't passed the fill deadline yet. Retry in a minute.");
    }
    if (
      local.kind === "absent" &&
      Math.max(chainTime, nowSecs) + MINT_WINDOW_MARGIN_SECS > fillDeadline + NOT_FILLED_WINDOW_SECS
    ) {
      return "solana-window-elapsed";
    }
    return undefined;
  });
}

/** Everything `deriveRefundView` needs, read fresh from chain. */
export async function readRefundSnapshot(
  order: EscrowRefundOrder,
  nowSecs: number
): Promise<RefundSnapshot> {
  const escrow = await readEscrowState(order);
  if (escrow !== "deposited") return { escrow, outputs: [], fast: null };
  const outputs = await readOutputFills(order);
  // Any filled or unreadable output blocks refunds outright; no point in fast reads.
  if (
    outputs.length !== order.order.outputs.length ||
    outputs.some((fill) => fill !== "unfilled") ||
    order.meta.orderDeliveredTxHash ||
    order.meta.orderSettledTxHash ||
    order.meta.orderStatus === "Delivered" ||
    order.meta.orderStatus === "Settled" ||
    nowSecs > order.order.expires
  ) {
    return { escrow, outputs, fast: null };
  }
  return { escrow, outputs, fast: await readFastProgress(order, nowSecs) };
}

/**
 * Re-reads the chain immediately before a spend and applies `preSpendVerdict`
 * (plan §5.5). Throws `RefundActionError` with user-facing copy when the
 * action is no longer valid; resolves `"already-proven"` when a third party
 * delivered the non-fill proof, so the caller can skip its spend.
 */
export async function assertStillRefundable(
  order: EscrowRefundOrder,
  mode: SpendMode,
  rail?: FastRail
): Promise<"go" | "already-proven"> {
  if (mode !== "slow" && !rail) {
    throw new Error(`assertStillRefundable(${mode}) needs the fast rail`);
  }
  const [escrow, outputs, attested] = await Promise.all([
    readEscrowState(order),
    readOutputFills(order),
    mode !== "slow" && rail ? readAttested(order, rail) : Promise.resolve(false)
  ]);
  const verdict = preSpendVerdict(
    order,
    mode,
    { escrow, outputs, attested },
    Math.floor(Date.now() / 1000)
  );
  if (typeof verdict === "object") throw new RefundActionError(verdict.blocked);
  if (
    verdict === "go" &&
    rail?.provider === "wormhole" &&
    (mode === "record" || mode === "prove")
  ) {
    const viable = await checkFastRailOnChain(order, rail);
    if (viable !== true)
      throw new RefundActionError(
        "Wormhole route is unavailable. Refresh or use the regular refund after expiry."
      );
    if (mode === "record" && rail.destKind === "solana") {
      const unavailable = await readSolanaLocalProgress(
        order,
        { rail, attested: false, source: null },
        Math.floor(Date.now() / 1000)
      );
      if (unavailable)
        throw new RefundActionError(
          unavailable === "solana-window-elapsed"
            ? "Solana non-fill proofs must be created within 48h of the fill deadline."
            : "A non-fill record for this output already exists in an unusable state."
        );
    }
  }
  return verdict;
}
