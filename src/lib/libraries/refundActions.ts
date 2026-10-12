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
import { bytes32ToAddress, type EVMOrder, type StandardSolana } from "@lifi/intent";
import { getChain, getClient, type WC } from "$lib/config";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
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
import { pollPolymerProof, type PolymerProofBody } from "./polymerProof";
import { polymerReceiveFunction } from "./polymerReceive";
import { loadBreadcrumb, saveBreadcrumb } from "./refundBreadcrumbs";
import type { EscrowRefundOrder } from "./refundLookup";
import { assertStillRefundable, RefundActionError } from "./refundReads";
import { chainLabel, type FastRail, type ProofSource } from "./refundState";
import { solanaDeps, tronDeps } from "./solver";

export { RefundActionError };

const REVERT_COPY: Record<string, string> = {
  AlreadyFilled: "An output was filled. Refund isn't possible.",
  FillDeadlineNotPassed: "The destination hasn't passed the fill deadline yet. Retry in a minute.",
  InvalidOrderStatus: "The order is no longer open. Refreshing…",
  TimestampNotPassed: "The chain clock hasn't reached the deadline yet.",
  NotProven: "The origin oracle has no non-fill proof yet.",
  ZeroValue: "The origin oracle can't accept proofs from this destination."
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
  simFailure?: string
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

/** `refund(order)` after expiry. */
export async function submitSlowRefund(order: EscrowRefundOrder): Promise<TxRef> {
  await assertStillRefundable(order, "slow");
  const origin = order.order.originChainId;
  switch (getChainType(origin)) {
    case "solana":
      return refundSolana(await solanaDeps(origin), {
        order: order.order as StandardSolana,
        orderId: order.orderId
      });
    case "tron":
      return tronRef(
        await refundTron(await tronDeps(), {
          inputSettler: order.container.inputSettler,
          order: order.order as EVMOrder
        })
      );
    case "evm":
      return sendEvm(origin, {
        address: order.container.inputSettler,
        abi: SETTLER_ESCROW_ABI,
        functionName: "refund",
        args: [order.order as EVMOrder]
      });
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

/**
 * Step 2a: ask Polymer to prove the record. The Polymer job index is persisted
 * per source, so "Check again" (or a reload) polls the same job instead of
 * placing a new request.
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
  const { orderId } = order;
  const { outputIndex } = rail;
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
  const crumb = loadBreadcrumb(orderId, outputIndex);
  let attempt = 0;
  onProgress?.(attempt, PROOF_WAITS_MS.length);
  let result;
  try {
    result = await pollPolymerProof(body, {
      polymerIndex: crumb?.polymerSourceKey === sourceKey ? crumb.polymerIndex : undefined,
      waitsMs: PROOF_WAITS_MS,
      onIndex: (index) => {
        saveBreadcrumb(orderId, outputIndex, { polymerIndex: index, polymerSourceKey: sourceKey });
        onProgress?.(++attempt, PROOF_WAITS_MS.length);
      }
    });
  } catch (error) {
    // The job failed for good; the next attempt must place a fresh request.
    saveBreadcrumb(orderId, outputIndex, { polymerIndex: undefined, polymerSourceKey: undefined });
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
  proof: `0x${string}`
): Promise<TxRef | null> {
  // Re-checked here, not trusted from before the poll: polling Polymer can
  // outlast a fill, an expiry, the expiry buffer, or a third party delivering
  // the same proof (then this is a no-op).
  if ((await assertStillRefundable(order, "prove", rail)) === "already-proven") return null;
  const { originChainId: origin, inputOracle } = order.order;
  const { output } = rail;
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
  switch (getChainType(origin)) {
    case "solana":
      return refundOnNonFillSolana(await solanaDeps(origin), {
        order: order.order as StandardSolana,
        orderId: order.orderId,
        outputIndex: rail.outputIndex,
        output: rail.output,
        notFilledHash: rail.notFilledHash
      });
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
        "Proof is on-chain but the refund reverts. Contact support with the order id."
      );
  }
}
