import type { MandateOutput } from "@lifi/intent";
import { INPUT_SETTLER_ESCROW_PROGRAM_ID, OUTPUT_SETTLER_SIMPLE_PROGRAM_ID } from "$lib/idl";
import { findFinalisedLog, findOutputFilledLog } from "./events";
import { orderContextPda, pubkeyToBytes32 } from "./pda";
import type { SolanaTransactionLike } from "./types";

export function successfulSolanaTransaction(
  value: unknown
): value is NonNullable<SolanaTransactionLike> {
  if (!value || typeof value !== "object") return false;
  const tx = value as NonNullable<SolanaTransactionLike>;
  return (
    Number.isSafeInteger(tx.slot) &&
    tx.slot > 0 &&
    !!tx.meta &&
    tx.meta.err === null &&
    Array.isArray(tx.meta.logMessages) &&
    tx.meta.logMessages.every((log) => typeof log === "string")
  );
}

export function verifiedFill(tx: unknown, orderId: `0x${string}`, output: MandateOutput) {
  if (!successfulSolanaTransaction(tx))
    throw new Error("Solana transaction is failed, unconfirmed, or unavailable");
  return findOutputFilledLog(tx.meta!.logMessages!, {
    programId: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
    orderId,
    output
  });
}

export function verifiedFinalisation(tx: unknown, orderId: `0x${string}`) {
  if (!successfulSolanaTransaction(tx)) return undefined;
  return findFinalisedLog(tx.meta!.logMessages!, {
    programId: INPUT_SETTLER_ESCROW_PROGRAM_ID,
    orderId,
    orderContext: pubkeyToBytes32(orderContextPda(orderId))
  });
}

export function verifiedAtomicSettlement(
  tx: unknown,
  orderId: `0x${string}`,
  output: MandateOutput
): boolean {
  const finalised = verifiedFinalisation(tx, orderId);
  if (!finalised) return false;
  const fill = verifiedFill(tx, orderId, output);
  if (fill.solver.toLowerCase() !== finalised.solver.toLowerCase())
    throw new Error("Fill and settlement solver do not match");
  return true;
}
