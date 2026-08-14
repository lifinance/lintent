import { parseEventLogs } from "viem";
import type { MandateOutput } from "@lifi/intent";
import { bytes32ToAddress } from "@lifi/intent";
import { getClient } from "$lib/config";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { isSolanaChain, isTronChain } from "$lib/utils/chainType";
import type { TxRef } from "$lib/utils/txRef";
import { OUTPUT_SETTLER_SIMPLE_PROGRAM_ID } from "$lib/idl";
import { getSolanaReads } from "$lib/solana/client";
import { findOutputFilledLog } from "$lib/solana/events";
import { getTronReads } from "$lib/tron/client";
import {
  decodeOutputFilledFromTronLogs,
  getTronTransactionInfo,
  outputStructHash
} from "$lib/tron/reads";
import { getOrFetchRpc } from "$lib/libraries/rpcCache";

export type FillDetails = {
  /** bytes32 solver identifier recorded on-chain by the fill. */
  solver: `0x${string}`;
  /** The uint32 timestamp emitted in OutputFilled — the exact value hashed
   * into the fill payload, NOT the block timestamp. */
  timestamp: number;
};

const FILL_DETAILS_TTL_MS = 300_000; // immutable once mined — cache generously

/**
 * Resolves the solver and timestamp for a fill from its OutputFilled event.
 * This is the single source of truth for solver identity: deriving it from
 * `receipt.from` or the connected account breaks solver overrides and
 * cross-namespace fills (the recorded solver is whatever fillerData proposed,
 * not the transaction sender).
 */
export async function getFillDetails(
  orderId: `0x${string}`,
  output: MandateOutput,
  fillTransactionHash: TxRef
): Promise<FillDetails> {
  const cacheKey = `fill-details:${orderId}:${outputStructHash(output)}:${fillTransactionHash}`;
  return getOrFetchRpc(
    cacheKey,
    async () => {
      if (isSolanaChain(output.chainId)) {
        const reads = await getSolanaReads(output.chainId);
        // "confirmed", deliberately: `signAndSend` has already waited for this
        // commitment and read the transaction back, so by the time we get here
        // the read costs nothing. Waiting for "finalized" instead added ~13s
        // (about 32 slots) to every fill before the proof could even be built.
        //
        // What that trades away: a confirmed slot can in principle still be
        // dropped, and the result below is memoised for the session. If that
        // ever happened the cached timestamp would be stale and every retry
        // would fail with InvalidLocalAttestationTimestamp until a reload. It
        // cannot mint a false proof — `validate_payload` compares against the
        // on-chain LocalAttestation — so the failure is loud, not silent.
        const tx = await reads.getTransaction(fillTransactionHash, { commitment: "confirmed" });
        if (!tx?.meta) {
          // Deliberately does not blame finality. An empty result means "this
          // RPC does not have the transaction", which is just as often a
          // pruned history or a load-balanced node that has not caught up as
          // it is a fill that has not landed.
          throw new Error(
            `Solana RPC returned no transaction for ${fillTransactionHash}. It may not have landed yet, or this endpoint may not carry it — retry, and if it persists check the fill signature.`
          );
        }
        if (tx.meta.err) {
          throw new Error(`Solana fill transaction reverted: ${JSON.stringify(tx.meta.err)}`);
        }
        const { solver, timestamp } = findOutputFilledLog(tx.meta.logMessages ?? [], {
          programId: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
          orderId,
          output
        });
        return { solver, timestamp };
      }

      if (isTronChain(output.chainId)) {
        const reads = await getTronReads();
        // Deliberately the solidity node: this result is cached as immutable,
        // so it must never contain data from a reorgable (unsolidified) fill.
        const txInfo = await getTronTransactionInfo(reads, fillTransactionHash);
        if (typeof txInfo.blockNumber !== "number") {
          throw new Error("Tron fill is awaiting solidification — retry in about a minute");
        }
        const { solver, timestamp } = decodeOutputFilledFromTronLogs(txInfo, {
          emitterBytes32: output.settler,
          orderId,
          output
        });
        return { solver, timestamp };
      }

      // Reached only on the EVM branch, where a TxRef is a 0x hash.
      const receipt = await getClient(output.chainId).getTransactionReceipt({
        hash: fillTransactionHash as `0x${string}`
      });
      if (receipt.status !== "success") {
        throw new Error(`Fill transaction ${fillTransactionHash} reverted`);
      }
      const expectedEmitter = bytes32ToAddress(output.settler).toLowerCase();
      const expectedHash = outputStructHash(output).toLowerCase();
      const logs = parseEventLogs({
        abi: COIN_FILLER_ABI,
        eventName: "OutputFilled",
        logs: receipt.logs
      });
      const matches = logs.filter(
        (log) =>
          log.address.toLowerCase() === expectedEmitter &&
          log.args.orderId.toLowerCase() === orderId.toLowerCase() &&
          outputStructHash(log.args.output as MandateOutput).toLowerCase() === expectedHash
      );
      if (matches.length === 0) {
        throw new Error("No matching OutputFilled event found in fill transaction");
      }
      if (matches.length > 1) {
        throw new Error(
          `Ambiguous fill: ${matches.length} OutputFilled events match the same order and output`
        );
      }
      const match = matches[0];
      return {
        solver: match.args.solver as `0x${string}`,
        timestamp: Number(match.args.timestamp)
      };
    },
    { ttlMs: FILL_DETAILS_TTL_MS }
  );
}
