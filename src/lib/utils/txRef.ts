// Chain-agnostic transaction references.
//
// EVM and Tron identify a transaction by a 32-byte hash; Solana uses a 64-byte
// signature rendered in base58. They have no common syntax, so the app cannot
// keep typing these as `0x${string}` — and the checks scattered across the
// screens all assumed 0x-prefixed 66-char strings.
//
// The subtlety worth stating once: a FILL transaction belongs to the OUTPUT
// chain, not the source chain. A Solana fill of an EVM-input order is base58
// even though the order's source chain is EVM, so validation must be handed
// `output.chainId`, never `sourceChainId`.

import { base58 } from "@scure/base";
import { getChainType } from "./chainType";

/** A 0x-prefixed 32-byte hash (EVM, Tron) or a base58 signature (Solana). */
export type TxRef = string;

const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const BARE_TX_HASH = /^[0-9a-fA-F]{64}$/;

/** Solana signatures are 64 bytes; a 32-byte value is a pubkey, not a signature. */
function isSolanaSignature(value: string): boolean {
  try {
    return base58.decode(value).length === 64;
  } catch {
    return false;
  }
}

export function isValidTxRef(
  value: string | undefined | null,
  chainId: number | bigint | undefined
): value is TxRef {
  if (!value) return false;
  if (chainId !== undefined && getChainType(chainId) === "solana") {
    return isSolanaSignature(value);
  }
  // Tron reports transaction ids without the 0x prefix.
  if (chainId !== undefined && getChainType(chainId) === "tron") {
    return EVM_TX_HASH.test(value) || BARE_TX_HASH.test(value);
  }
  return EVM_TX_HASH.test(value);
}

/**
 * Canonical storage form. Tron ids gain the 0x prefix they are usually shown
 * without; Solana signatures are returned untouched, because base58 has no
 * prefix to add and lower-casing one would corrupt it.
 */
export function normalizeTxRef(value: string, chainId: number | bigint | undefined): TxRef {
  const trimmed = value.trim();
  if (chainId !== undefined && getChainType(chainId) === "solana") return trimmed;
  if (BARE_TX_HASH.test(trimmed)) return `0x${trimmed}`;
  return trimmed;
}

export function txRefPlaceholder(chainId: number | bigint | undefined): string {
  if (chainId === undefined) return "0x...";
  switch (getChainType(chainId)) {
    case "solana":
      return "base58 signature";
    case "tron":
      return "0x... or bare hex";
    default:
      return "0x...";
  }
}

export function txRefError(chainId: number | bigint | undefined): string {
  if (chainId !== undefined && getChainType(chainId) === "solana") {
    return "Enter a Solana transaction signature (base58, 64 bytes)";
  }
  return "Enter a 32-byte transaction hash";
}
