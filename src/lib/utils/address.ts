import { isAddress } from "viem";
import { isTronBase58Address, tronBase58ToHex } from "@lifi/intent";

/**
 * Resolves a user-entered address to its 20-byte hex form. Accepts EVM hex
 * addresses and Tron Base58Check addresses — the latter are checksum-verified
 * by the library, so a typo'd Tron address resolves to `undefined` instead of
 * silently becoming a different recipient.
 */
export function resolveAddress(value: string): `0x${string}` | undefined {
  if (isAddress(value, { strict: false })) return value;
  if (isTronBase58Address(value)) return tronBase58ToHex(value);
  return undefined;
}
