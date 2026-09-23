import { getOutputHash, type MandateOutput, type OrderContainer } from "@lifi/intent";
import { getSolanaReads } from "$lib/solana/client";
import {
  successfulSolanaTransaction,
  verifiedAtomicSettlement,
  verifiedFill,
  verifiedFinalisation
} from "$lib/solana/history";
import { isSolanaChain } from "$lib/utils/chainType";
import { containerToIntent } from "$lib/utils/intent";
import { getOrFetchRpc, invalidateRpcPrefix } from "./rpcCache";
import type { SolanaTransactionLike } from "$lib/solana/types";

async function receiptStore() {
  return (await import("$lib/state.svelte")).default;
}

/** Persist only successful RPC receipts; raw user-entered signatures are never evidence. */
export async function solanaTransaction(
  chainId: number | bigint,
  signature: string
): Promise<SolanaTransactionLike> {
  return getOrFetchRpc(
    `solana-tx:${chainId}:${signature}`,
    async () => {
      const store = await receiptStore();
      let tx: SolanaTransactionLike;
      try {
        tx = await (
          await getSolanaReads(chainId)
        ).getTransaction(signature, { commitment: "confirmed" });
      } catch (error) {
        const saved = store.getSolanaTransactionReceipt(chainId, signature);
        if (saved) return saved;
        throw error;
      }
      if (tx?.meta?.err) throw new Error(`Solana transaction ${signature} failed`);
      if (!tx) tx = store.getSolanaTransactionReceipt(chainId, signature) ?? null;
      if (!successfulSolanaTransaction(tx))
        throw new Error(
          `Solana transaction ${signature} is not confirmed or its logs are unavailable`
        );
      store.transactionReceipts[`${chainId}:${signature}`] = JSON.stringify(tx);
      await store
        .saveTransactionReceipt(chainId, signature, tx)
        .catch((error) => console.warn("Could not persist Solana receipt", error));
      return tx;
    },
    { ttlMs: 300_000 }
  );
}

export async function solanaFillEvidence(
  orderId: `0x${string}`,
  output: MandateOutput,
  signature?: string
) {
  if (signature)
    return verifiedFill(await solanaTransaction(output.chainId, signature), orderId, output);
  const store = await receiptStore();
  for (const [key, value] of Object.entries(store.transactionReceipts)) {
    if (!key.startsWith(`${output.chainId}:`)) continue;
    try {
      return verifiedFill(JSON.parse(value), orderId, output);
    } catch {
      /* unrelated receipt */
    }
  }
  return undefined;
}

export async function solanaOrderSettled(
  container: OrderContainer,
  fillSignature?: string
): Promise<boolean> {
  const { order } = container;
  if (!("originChainId" in order) || !isSolanaChain(order.originChainId)) return false;
  const orderId = containerToIntent(container).orderId();
  if (
    fillSignature &&
    order.outputs.length === 1 &&
    BigInt(order.outputs[0].chainId) === BigInt(order.originChainId)
  ) {
    const tx = await solanaTransaction(order.originChainId, fillSignature);
    if (verifiedAtomicSettlement(tx, orderId, order.outputs[0])) return true;
  }
  const store = await receiptStore();
  for (const [key, value] of Object.entries(store.transactionReceipts)) {
    if (!key.startsWith(`${order.originChainId}:`)) continue;
    try {
      if (verifiedFinalisation(JSON.parse(value), orderId)) return true;
    } catch {
      /* unrelated receipt */
    }
  }
  return false;
}

export function invalidateSolanaProgress() {
  for (const prefix of ["progress:", "claim:", "fill-details:"]) invalidateRpcPrefix(prefix);
}

/** Cache the fill transaction before cleanup can remove the on-chain record. */
export async function rememberSolanaFill(
  orderId: `0x${string}`,
  output: MandateOutput,
  signature: string
) {
  const fill = await solanaFillEvidence(orderId, output, signature);
  if (!fill || getOutputHash(fill.output) !== getOutputHash(output))
    throw new Error("Fill receipt does not match output");
  invalidateSolanaProgress();
}

/** A cleanup must not remove the record if its receipt cannot be stored durably. */
export async function persistFillBeforeCleanup(
  orderId: `0x${string}`,
  output: MandateOutput,
  signature?: string
) {
  const store = await receiptStore();
  await store.dbReady;
  if (signature) {
    const tx = await solanaTransaction(output.chainId, signature);
    verifiedFill(tx, orderId, output);
    await store.saveTransactionReceipt(output.chainId, signature, tx);
    return;
  }
  const prefix = `${output.chainId}:`;
  for (const [key, value] of Object.entries(store.transactionReceipts)) {
    if (!key.startsWith(prefix)) continue;
    let tx: unknown;
    try {
      tx = JSON.parse(value);
      verifiedFill(tx, orderId, output);
    } catch {
      continue;
    }
    await store.saveTransactionReceipt(output.chainId, key.slice(prefix.length), tx);
    return;
  }
  throw new Error("Add the confirmed fill transaction before reclaiming rent");
}
