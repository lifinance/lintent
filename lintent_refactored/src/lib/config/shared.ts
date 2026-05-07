// Shared constants and utilities — no VM-specific library imports in consuming SVM/EVM code.

import {
  BYTES32_ZERO as _BYTES32_ZERO,
  ADDRESS_ZERO as _ADDRESS_ZERO,
  COIN_FILLER as _COIN_FILLER,
  addressToBytes32 as _addressToBytes32,
} from "@lifi/intent";

export const BYTES32_ZERO: `0x${string}` = _BYTES32_ZERO as `0x${string}`;
export const ADDRESS_ZERO: `0x${string}` = _ADDRESS_ZERO;
export const SHARED_COIN_FILLER: `0x${string}` = _COIN_FILLER;

export { _addressToBytes32 as addressToBytes32 };

/** Ensure a string is a 0x-prefixed EVM hex address. Throws on invalid input. */
export function toEvmAddress(address: string): `0x${string}` {
  if (!address.startsWith("0x"))
    throw new Error(`Invalid EVM address (missing 0x prefix): ${address}`);
  return address as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Solana address utilities
// Pure-JS base58 ↔ bytes32 — no @solana/web3.js dependency required.
// Ported from intent.ts_refactored/src/svm/helpers/encoding.ts
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET[i]!] = i;
}

function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of s) {
    const value = BASE58_MAP[char];
    if (value === undefined)
      throw new Error(`Invalid base58 character: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of s) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let result = "";
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)]! + result;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

/** Returns true when `s` looks like a valid 32-byte Solana public key (base58). */
export function isSolanaAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  for (const c of s) {
    if (BASE58_MAP[c] === undefined) return false;
  }
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/**
 * Convert a Solana base58 public key to a 0x-prefixed 32-byte hex string.
 * Equivalent to `new PublicKey(address).toBytes()` without @solana/web3.js.
 */
export function solanaAddressToBytes32(address: string): `0x${string}` {
  const bytes = base58Decode(address);
  if (bytes.length !== 32) {
    throw new Error(
      `Invalid Solana address length: expected 32 bytes, got ${bytes.length} (input: ${address})`,
    );
  }
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Convert a 0x-prefixed 32-byte hex string back to a Solana base58 public key.
 * Inverse of `solanaAddressToBytes32`.
 */
export function bytes32ToSolanaAddress(hex: `0x${string}`): string {
  const raw = hex.replace("0x", "");
  if (raw.length !== 64) {
    throw new Error(
      `Invalid bytes32 length: expected 64 hex chars, got ${raw.length}`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(raw.substring(i * 2, i * 2 + 2), 16);
  }
  return base58Encode(bytes);
}

// ---------------------------------------------------------------------------
// Cross-VM oracle addresses
// EVM-side Polymer oracle addresses needed for both EVM→EVM and SVM→EVM intents.
// ---------------------------------------------------------------------------

/** Polymer oracle address on each EVM chain (testnet).
 *  Verified 2026-04-28 against on-chain `chainIdMap(2) = 1151111081099712`. */
export const SHARED_POLYMER_ORACLE_TESTNET: Record<number, `0x${string}`> = {
  11155111: "0xa056B481CD36eE61b0C417403A1d48aF481378b3", // sepolia
  84532: "0xa056B481CD36eE61b0C417403A1d48aF481378b3", // baseSepolia
  421614: "0xa056B481CD36eE61b0C417403A1d48aF481378b3", // arbitrumSepolia
  11155420: "0xa056B481CD36eE61b0C417403A1d48aF481378b3", // optimismSepolia
};

/** Polymer oracle address on each EVM chain (mainnet).
 *  Base mainnet redeployed 2026-04-28 with chainIdMap(2) = 1151111081099710. */
export const SHARED_POLYMER_ORACLE_MAINNET: Record<number, `0x${string}`> = {
  1: "0x0000003E06000007A224AeE90052fA6bb46d43C9", // ethereum
  42161: "0x0000003E06000007A224AeE90052fA6bb46d43C9", // arbitrum
  8453: "0x3a8054ea5Cca4e403b7C942054cC9BD6A71D2b3f", // base (Solana-aware redeploy)
  6342: "0x0000003E06000007A224AeE90052fA6bb46d43C9", // megaeth
  747: "0x0000003E06000007A224AeE90052fA6bb46d43C9", // katana
  137: "0x0000003E06000007A224AeE90052fA6bb46d43C9", // polygon
  56: "0x0000003E06000007A224AeE90052fA6bb46d43C9", // bsc
};

export function getSharedPolymerOracle(
  mainnet: boolean,
): Record<number, `0x${string}`> {
  return mainnet
    ? SHARED_POLYMER_ORACLE_MAINNET
    : SHARED_POLYMER_ORACLE_TESTNET;
}
