// Refund transaction executors. Each one re-checks the chain right before the
// spend (refundReads.assertStillRefundable), then dispatches on the VM of the
// chain it writes to. Every call here is permissionless and pays out to
// `order.user`, so any connected wallet may send it.

import {
  hexToBytes,
  type Abi,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type PublicClient
} from "viem";
import {
  bytes32ToAddress,
  encodeNotFilledDescription,
  type EVMOrder,
  type StandardSolana
} from "@lifi/intent";
import { getChain, getClient, type WC } from "$lib/config";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { WORMHOLE_ORACLE_ABI } from "$lib/abi/wormholeoracle";
import store from "$lib/state.svelte";
import { getChainType } from "$lib/utils/chainType";
import { extractRevertReason } from "$lib/utils/revert";
import type { TxRef } from "$lib/utils/txRef";
import { POLYMER_PROGRAM_ID } from "$lib/idl";
import { polymerScratchPdas } from "$lib/solana/pda";
import { readPolymerProverId } from "$lib/solana/reads";
import {
  receiveProof as receiveSolanaProof,
  recordNotFilled as recordSolanaNotFilled,
  refund as refundSolana,
  refundOnNonFill as refundOnNonFillSolana
} from "$lib/solana/writes";
import {
  emitNotFilled as emitTronNotFilled,
  refund as refundTron,
  refundOnNonFill as refundOnNonFillTron,
  submitReceiveMessage as submitTronReceiveMessage
} from "$lib/tron/writes";
import { PolymerJobFailedError, pollPolymerProof, type PolymerProofBody } from "./polymerProof";
import { polymerReceiveFunction } from "./polymerReceive";
import { saveBreadcrumb } from "./refundBreadcrumbs";
import type { EscrowRefundOrder } from "./refundLookup";
import { assertStillRefundable, readAttested, RefundActionError } from "./refundReads";
import { chainLabel, type FastRail, type ProofSource } from "./refundState";
import { solanaDeps, tronDeps } from "./solver";
import type { SolanaDeps } from "$lib/solana/types";
import { oracleProviderFor } from "./oracleRoute";
import {
  assertWormholeVaa,
  findWormholePublication,
  pollWormholeVaa,
  publishEvmWormhole,
  saveWormholeHint,
  verifyWormholePublication,
  type WormholeExpectedMessage,
  type WormholePublication
} from "./wormholeProof";

export { RefundActionError };

const REVERT_COPY: Record<string, string> = {
  AlreadyFilled: "An output was filled. Refund isn't possible.",
  FillDeadlineNotPassed: "The destination hasn't passed the fill deadline yet. Retry in a minute.",
  InvalidOrderStatus: "The order is no longer open. Refreshing…",
  TimestampNotPassed: "The chain clock hasn't reached the deadline yet.",
  NotProven: "The origin oracle has no non-fill proof yet.",
  ZeroValue: "The origin oracle can't accept proofs from this destination.",
  NotAllPayloadsValid: "The destination has not attested every payload in this publication.",
  RefundFailed: "The Wormhole publication's excess-fee refund failed.",
  VMSignatureInvalid: "Wormhole rejected the VAA guardian signature.",
  InvalidGuardianSet: "Wormhole rejected the VAA guardian set.",
  GuardianSetExpired: "The VAA guardian set has expired.",
  NoQuorum: "The VAA does not contain enough guardian signatures."
};

/** User-facing text for a failed action. */
export function describeActionError(error: unknown): string {
  if (error instanceof RefundActionError) return error.message;
  const e = error as { name?: string; code?: number; message?: string; cause?: unknown };
  const message = e?.message ?? String(error);
  if (
    e?.name === "UserRejectedRequestError" ||
    e?.code === 4001 ||
    /user rejected|rejected the request/i.test(message)
  ) {
    return "Rejected in wallet.";
  }
  const reason = extractRevertReason(error);
  const known = Object.keys(REVERT_COPY).find((name) => reason.startsWith(name));
  return known ? REVERT_COPY[known]! : reason;
}

type EvmWallet = { walletClient: WC; account: `0x${string}` };

async function ensureEvmWallet(chainId: number | bigint): Promise<EvmWallet> {
  await store.setWalletToCorrectChain(Number(chainId));
  const walletClient = store.walletClient;
  const account = store.connectedAccount?.address;
  if (!walletClient || !account) throw new RefundActionError("Connect an EVM wallet.");
  if ((await walletClient.getChainId()) !== Number(chainId)) {
    throw new RefundActionError(`Switch your wallet to ${chainLabel(chainId)}.`);
  }
  return { walletClient, account };
}

/**
 * Simulate, send and await one EVM call, the same sequence as Solver.fill /
 * deliverProof. Simulating first turns a revert into a decoded reason before
 * the user is asked to sign. `simFailure` replaces the message for a revert at
 * simulation, for steps where any revert means something specific.
 */
async function sendEvm<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, "nonpayable" | "payable">
>(
  chainId: number | bigint,
  call: {
    address: `0x${string}`;
    abi: abi;
    functionName: functionName;
    args: ContractFunctionArgs<abi, "nonpayable" | "payable", functionName>;
  },
  simFailure?: string,
  beforeSpend?: () => Promise<void>
): Promise<`0x${string}`> {
  const { walletClient, account } = await ensureEvmWallet(chainId);
  // Narrowed from the per-chain client union, which viem's generic
  // simulate/write signatures can't resolve through this wrapper; the call
  // shape is enforced by this function's own signature instead.
  const client = getClient(chainId) as PublicClient;
  const request = { ...(call as object), account };
  try {
    await client.simulateContract(request as never);
  } catch (error) {
    if (simFailure) throw new RefundActionError(simFailure);
    throw new RefundActionError(describeActionError(error));
  }
  await beforeSpend?.();
  const hash = await walletClient.writeContract({
    ...request,
    chain: getChain(chainId)
  } as never);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
    pollingInterval: 2_000
  });
  if (receipt.status !== "success") {
    throw new RefundActionError(`Transaction ${hash} reverted on ${chainLabel(chainId)}.`);
  }
  return hash;
}

const tronRef = (txId: string): TxRef => `0x${txId.replace(/^0x/, "")}`;

/** A third party registering the proof during wallet preparation is a no-op. */
class AlreadyProven extends Error {}

function nonFillExpected(order: EscrowRefundOrder, rail: FastRail): WormholeExpectedMessage {
  return {
    application: rail.output.settler,
    payload: encodeNotFilledDescription({
      orderId: order.orderId,
      output: rail.output,
      fillDeadline: order.order.fillDeadline
    })
  };
}

function wormholeGuard(
  order: EscrowRefundOrder,
  mode: "record" | "prove" | "fast" | "slow",
  rail?: FastRail
) {
  return async () => {
    if ((await assertStillRefundable(order, mode, rail)) === "already-proven")
      throw new AlreadyProven();
  };
}

/** Compose at the real signing boundary, after the executor has prepared its wallet transaction. */
function guardedSolanaDeps(deps: SolanaDeps, beforeSpend: () => Promise<void>): SolanaDeps {
  return {
    ...deps,
    signer: {
      ...deps.signer,
      signAndSend: (instructions, opts) =>
        deps.signer.signAndSend(instructions, {
          ...opts,
          beforeSign: async () => {
            await opts?.beforeSign?.();
            await beforeSpend();
          }
        })
    }
  };
}

async function verifiedSource(
  order: EscrowRefundOrder,
  rail: FastRail,
  source: ProofSource
): Promise<WormholePublication> {
  if (source.kind !== "wormhole")
    throw new RefundActionError("Expected a verified Wormhole publication.");
  const publication = await verifyWormholePublication(
    rail.output,
    nonFillExpected(order, rail),
    source.publication
  );
  if (!publication)
    throw new RefundActionError(
      "Wormhole publication history unavailable. Retry with an archival RPC or the publication transaction."
    );
  saveWormholeHint(rail.output, nonFillExpected(order, rail), publication);
  return publication;
}

/** `refund(order)` after expiry. */
export async function submitSlowRefund(order: EscrowRefundOrder): Promise<TxRef> {
  await assertStillRefundable(order, "slow");
  const origin = order.order.originChainId;
  const beforeSpend =
    oracleProviderFor(order.order.originChainId, order.order.inputOracle) === "wormhole"
      ? wormholeGuard(order, "slow")
      : undefined;
  switch (getChainType(origin)) {
    case "solana":
      return refundSolana(
        beforeSpend
          ? guardedSolanaDeps(await solanaDeps(origin), beforeSpend)
          : await solanaDeps(origin),
        {
          order: order.order as StandardSolana,
          orderId: order.orderId
        }
      );
    case "tron":
      return tronRef(
        await refundTron(await tronDeps(), {
          inputSettler: order.container.inputSettler,
          order: order.order as EVMOrder
        })
      );
    case "evm":
      return sendEvm(
        origin,
        {
          address: order.container.inputSettler,
          abi: SETTLER_ESCROW_ABI,
          functionName: "refund",
          args: [order.order as EVMOrder]
        },
        undefined,
        beforeSpend
      );
  }
}

/**
 * Step 1: record the non-fill on the destination (`emitNotFilled`, or Solana
 * `attest_not_filled` + `submit_consume`). The reference is saved as a resume
 * hint; the proof source itself is located from chain on the next refresh.
 */
export async function submitNonFillRecord(
  order: EscrowRefundOrder,
  rail: FastRail
): Promise<TxRef | null> {
  // Already proven by someone else: nothing to record.
  if ((await assertStillRefundable(order, "record", rail)) === "already-proven") return null;
  const { output, outputIndex } = rail;
  const { orderId } = order;
  const fillDeadline = order.order.fillDeadline;
  if (rail.provider === "wormhole") {
    const expected = nonFillExpected(order, rail);
    const existing = await findWormholePublication(output, expected);
    if (existing) {
      saveWormholeHint(output, expected, existing);
      return existing.txRef ?? null;
    }
    const beforeSpend = wormholeGuard(order, "record", rail);
    try {
      let publication: WormholePublication;
      if (rail.destKind === "solana") {
        // Platform code stays lazy: Core/Anchor dependencies are not SSR state.
        const { publishSolanaWormhole } = await import("$lib/solana/wormhole");
        publication = await publishSolanaWormhole(await solanaDeps(output.chainId), {
          kind: "non-fill",
          orderId,
          output,
          payload: expected.payload,
          timestamp: fillDeadline,
          beforeSpend
        });
      } else if (rail.destKind === "evm") {
        const { walletClient, account } = await ensureEvmWallet(output.chainId);
        publication = await publishEvmWormhole(output, expected.payload, walletClient, account, {
          beforeSpend
        });
      } else {
        throw new RefundActionError("Wormhole publication is unavailable on this destination.");
      }
      saveWormholeHint(output, expected, publication);
      return publication.txRef ?? null;
    } catch (error) {
      if (error instanceof AlreadyProven) return null;
      throw error;
    }
  }
  switch (rail.destKind) {
    case "solana": {
      const signature = await recordSolanaNotFilled(await solanaDeps(output.chainId), {
        orderId,
        output,
        fillDeadline,
        nowSecs: Math.floor(Date.now() / 1000)
      });
      saveBreadcrumb(orderId, outputIndex, { recordSignature: signature });
      return signature;
    }
    case "tron": {
      const txId = tronRef(
        await emitTronNotFilled(await tronDeps(), {
          outputSettlerBytes32: output.settler,
          orderId,
          output,
          fillDeadline
        })
      );
      saveBreadcrumb(orderId, outputIndex, { emitTxHash: txId as `0x${string}` });
      return txId;
    }
    case "evm": {
      const hash = await sendEvm(output.chainId, {
        address: bytes32ToAddress(output.settler),
        abi: COIN_FILLER_ABI,
        functionName: "emitNotFilled",
        args: [orderId, output, fillDeadline]
      });
      saveBreadcrumb(orderId, outputIndex, { emitTxHash: hash });
      return hash;
    }
  }
}

export type NonFillProofResult =
  | { status: "proof"; proof: `0x${string}` }
  | { status: "pending" }
  | { status: "attested" };

export const PROOF_WAITS_MS = [2000, 3000, 5000, 8000, 13000, 20000] as const;

// Polymer job index per chain-verified proof source, for this page session.
// In memory only: see refundBreadcrumbs.ts for why it is never persisted.
const polymerIndexBySource = new Map<string, number>();

/**
 * Step 2a: ask Polymer to prove the record. The Polymer job index is kept per
 * source for this session, so "Check again" polls the same job instead of
 * placing a new request. A reload places a new one.
 */
export async function fetchNonFillProof(
  order: EscrowRefundOrder,
  rail: FastRail,
  source: ProofSource,
  onProgress?: (attempt: number, total: number) => void
): Promise<NonFillProofResult> {
  if ((await assertStillRefundable(order, "prove", rail)) === "already-proven") {
    return { status: "attested" };
  }
  if (rail.provider === "wormhole") {
    const publication = await verifiedSource(order, rail, source);
    return pollWormholeVaa(publication, nonFillExpected(order, rail), { onProgress });
  }
  if (source.kind === "wormhole")
    throw new RefundActionError("A Wormhole publication cannot prove a Polymer refund.");
  const body: PolymerProofBody =
    source.kind === "evm"
      ? {
          srcChainId: source.chainId,
          srcBlockNumber: Number(source.blockNumber),
          globalLogIndex: source.logIndex,
          mainnet: true
        }
      : {
          srcChainId: Number(rail.output.chainId),
          txSignature: source.signature,
          programID: POLYMER_PROGRAM_ID,
          mainnet: true
        };
  const sourceKey =
    source.kind === "evm"
      ? `evm:${source.chainId}:${source.blockNumber}:${source.logIndex}`
      : `solana:${source.signature}`;
  let attempt = 0;
  onProgress?.(attempt, PROOF_WAITS_MS.length);
  let result;
  try {
    result = await pollPolymerProof(body, {
      polymerIndex: polymerIndexBySource.get(sourceKey),
      waitsMs: PROOF_WAITS_MS,
      onIndex: (index) => {
        polymerIndexBySource.set(sourceKey, index);
        onProgress?.(++attempt, PROOF_WAITS_MS.length);
      }
    });
  } catch (error) {
    if (!(error instanceof PolymerJobFailedError)) {
      throw new RefundActionError(
        `Couldn't reach Polymer. Retry to resume the same request. (${extractRevertReason(error)})`
      );
    }
    // The job failed for good; the next attempt must place a fresh request.
    polymerIndexBySource.delete(sourceKey);
    throw new RefundActionError(
      `Polymer couldn't generate a proof. Retrying starts a new request. (${extractRevertReason(error)})`
    );
  }
  if (result.status === "pending") return { status: "pending" };
  return { status: "proof", proof: result.proof };
}

/** Step 2b: deliver the proof to the origin oracle. */
export async function submitNonFillProof(
  order: EscrowRefundOrder,
  rail: FastRail,
  proof: `0x${string}`,
  source?: ProofSource,
  onProgress?: (stage: string) => void
): Promise<TxRef | null> {
  // Re-checked here, not trusted from before the poll: polling Polymer can
  // outlast a fill, an expiry, the expiry buffer, or a third party delivering
  // the same proof (then this is a no-op).
  if ((await assertStillRefundable(order, "prove", rail)) === "already-proven") return null;
  const { originChainId: origin, inputOracle } = order.order;
  const { output } = rail;
  if (rail.provider === "wormhole") {
    const expected = nonFillExpected(order, rail);
    const recovered =
      source ??
      (await findWormholePublication(output, expected).then((publication) =>
        publication ? { kind: "wormhole" as const, publication } : null
      ));
    if (!recovered)
      throw new RefundActionError(
        "Wormhole publication history unavailable. Retry with an archival RPC or the publication transaction."
      );
    const publication = await verifiedSource(order, rail, recovered);
    // Bind the actual bytes before wallet preparation, not just the order id.
    assertWormholeVaa(hexToBytes(proof), publication, expected);
    const beforeSpend = wormholeGuard(order, "prove", rail);
    try {
      let tx: TxRef | null;
      if (getChainType(origin) === "solana") {
        // Solana Core/Anchor are platform-specific and cannot initialize during SSR.
        const { receiveWormholeVaa } = await import("$lib/solana/wormhole");
        const result = await receiveWormholeVaa(await solanaDeps(origin), {
          proof,
          output,
          payloadHash: rail.notFilledHash,
          beforeSpend,
          onProgress
        });
        tx = result.attestSignature ?? null;
      } else if (getChainType(origin) === "evm") {
        onProgress?.("Register proof");
        tx = await sendEvm(
          origin,
          {
            address: inputOracle,
            abi: WORMHOLE_ORACLE_ABI,
            functionName: "receiveMessage",
            args: [proof]
          },
          undefined,
          beforeSpend
        );
      } else {
        throw new RefundActionError("Wormhole proof registration is unavailable on this origin.");
      }
      if (!(await readAttested(order, rail))) {
        throw new RefundActionError(
          "The transaction confirmed, but the origin non-fill proof is not registered. Retry to resume."
        );
      }
      return tx;
    } catch (error) {
      if (error instanceof AlreadyProven) return null;
      throw error;
    }
  }
  // Chosen by the chain the proof came FROM (the destination).
  const entryPoint = polymerReceiveFunction(output.chainId);
  switch (getChainType(origin)) {
    case "solana": {
      const deps = await solanaDeps(origin);
      const proverProgramId = await readPolymerProverId(deps.reads);
      const { attestSignature } = await receiveSolanaProof(deps, {
        proof: hexToBytes(proof),
        output,
        payloadHash: rail.notFilledHash,
        proverProgramId,
        proverAccounts: polymerScratchPdas(deps.signer.publicKey, proverProgramId)
      });
      // No signature: the attestation already existed — nothing left to do here.
      return attestSignature ?? null;
    }
    case "tron":
      return tronRef(
        await submitTronReceiveMessage(await tronDeps(), inputOracle, proof, entryPoint)
      );
    case "evm":
      return sendEvm(origin, {
        address: inputOracle,
        abi: POLYMER_ORACLE_ABI,
        functionName: entryPoint,
        args: [proof]
      });
  }
}

/** Step 3: `refundOnNonFill(order, outputIndex)` against the proven attestation. */
export async function submitFastRefund(order: EscrowRefundOrder, rail: FastRail): Promise<TxRef> {
  await assertStillRefundable(order, "fast", rail);
  const origin = order.order.originChainId;
  const beforeSpend = rail.provider === "wormhole" ? wormholeGuard(order, "fast", rail) : undefined;
  switch (getChainType(origin)) {
    case "solana":
      return refundOnNonFillSolana(
        beforeSpend
          ? guardedSolanaDeps(await solanaDeps(origin), beforeSpend)
          : await solanaDeps(origin),
        {
          order: order.order as StandardSolana,
          orderId: order.orderId,
          outputIndex: rail.outputIndex,
          output: rail.output,
          notFilledHash: rail.notFilledHash
        }
      );
    case "tron":
      return tronRef(
        await refundOnNonFillTron(await tronDeps(), {
          inputSettler: order.container.inputSettler,
          order: order.order as EVMOrder,
          outputIndex: rail.outputIndex
        })
      );
    case "evm":
      return sendEvm(
        origin,
        {
          address: order.container.inputSettler,
          abi: SETTLER_ESCROW_ABI,
          functionName: "refundOnNonFill",
          args: [order.order as EVMOrder, BigInt(rail.outputIndex)]
        },
        // Escrow is open and the attestation exists (just re-checked), so a
        // revert here is not something the user can fix.
        rail.provider === "wormhole"
          ? undefined
          : "Proof is on-chain but the refund reverts. Contact support with the order id.",
        beforeSpend
      );
  }
}
