import { isAddress } from "viem";
import {
  isSolanaBase58Address,
  isTronBase58Address,
  solanaBase58ToBytes32,
  tronBase58ToHex
} from "@lifi/intent";
import type { ChainType } from "$lib/utils/chainType";

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

/**
 * Resolves a user-entered address, accepting only the format the given chain
 * type can pay out to.
 *
 * `resolveAddress` above answers "is this any address"; this answers "is this
 * an address ON THAT CHAIN". The distinction is asset loss, not pedantry:
 * `@lifi/intent` runs every recipient through `addressToBytes32`, which
 * zero-pads a 20-byte EVM address into a 32-byte value — as a Solana pubkey
 * that is a key nobody controls — and the EVM output settler truncates a
 * 32-byte Solana key to its low 20 bytes on transfer (LibAddress.sol). Both
 * directions move funds to an address the user never meant, silently.
 *
 * EVM and Tron accept each other's text forms: both name the same 20-byte
 * secp256k1 identity, the app's internal form is the hex either way, and a
 * recipient must satisfy EVERY output chain type at once — rejecting `T...`
 * for a mixed Tron+EVM order would force the user to hand-convert an address
 * that is already exact. Solana accepts only base58: a 0x value is
 * indistinguishable from the padding mistake this function exists to catch.
 */
export function resolveAddressForChainType(
  value: string,
  chainType: ChainType
): `0x${string}` | undefined {
  const trimmed = value.trim();
  switch (chainType) {
    case "solana":
      return isSolanaBase58Address(trimmed) ? solanaBase58ToBytes32(trimmed) : undefined;
    case "tron":
    case "evm":
      if (isTronBase58Address(trimmed)) return tronBase58ToHex(trimmed);
      return isAddress(trimmed, { strict: false }) ? trimmed : undefined;
  }
}

/**
 * Does this bytes32 hold an address of `chainType`'s shape?
 *
 * The inverse question to `resolveAddressForChainType`: that one validates
 * user text before conversion, this one validates an already-converted value
 * on its way into a protocol field. Used for the exclusive-solver identity,
 * which lives in the INPUT chain's address space — the input settler is what
 * pays the solver out, so it is the one that must recognise the identity.
 *
 * EVM and Tron addresses occupy the low 20 bytes with 12 leading zero bytes;
 * Solana keys are 32 random bytes, so requiring those 12 bytes to be non-zero
 * catches a padded EVM address at a false-rejection rate of 2^-96.
 */
export function isBytes32ForChainType(value: `0x${string}`, chainType: ChainType): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return false;
  const isEvmPadded = value.slice(2, 26) === "0".repeat(24);
  return chainType === "solana" ? !isEvmPadded : isEvmPadded;
}
