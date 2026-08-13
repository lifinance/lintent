import { isAddress } from "viem";
import {
  isSolanaBase58Address,
  isTronBase58Address,
  solanaBase58ToBytes32,
  tronBase58ToHex
} from "@lifi/intent";

/**
 * Resolves a user-entered address to the app's internal hex form: 20 bytes for
 * EVM and Tron, 32 for Solana.
 *
 * Order matters. Tron is checked before Solana because a Tron address is
 * Base58Check — 34 characters decoding to a 21-byte payload — so it can never
 * satisfy the Solana 32-byte check, but testing Solana first would make the
 * intent of the ordering unclear. A typo'd Tron address resolves to
 * `undefined` because the library verifies its checksum.
 *
 * Solana base58 carries NO checksum, so a typo that still decodes to 32 bytes
 * resolves to a different, valid key. Callers must render the resolved address
 * back to the user before it is used as a recipient.
 */
export function resolveAddress(value: string): `0x${string}` | undefined {
  const trimmed = value.trim();
  if (isAddress(trimmed, { strict: false })) return trimmed;
  if (isTronBase58Address(trimmed)) return tronBase58ToHex(trimmed);
  if (isSolanaBase58Address(trimmed)) return solanaBase58ToBytes32(trimmed);
  return undefined;
}
