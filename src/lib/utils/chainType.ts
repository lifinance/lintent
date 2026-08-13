import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  TRON_MAINNET_CHAIN_ID,
  bytes32ToSolanaBase58,
  hexToTronBase58,
  isSolanaBase58Address,
  isTronBase58Address
} from "@lifi/intent";

export type ChainType = "evm" | "tron" | "solana";

const TRON_CHAIN_IDS = new Set([Number(TRON_MAINNET_CHAIN_ID)]);

// Solana's OIF chain ids (1151111081099710/11/12) are ~1.15e15, comfortably
// inside Number.MAX_SAFE_INTEGER (~9.0e15), so a Set<number> keyed on
// Number(chainId) is exact. Asserted in tests/unit/solanaSupport.test.ts.
const SOLANA_CHAIN_ID_SET = new Set([
  Number(SOLANA_MAINNET_CHAIN_ID),
  Number(SOLANA_TESTNET_CHAIN_ID),
  Number(SOLANA_DEVNET_CHAIN_ID)
]);

/** The Solana chain ids this app knows about, as bigints. Single source of truth. */
export const SOLANA_CHAIN_IDS: ReadonlySet<bigint> = new Set([
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID
]);

export function getChainType(chainId: number | bigint): ChainType {
  if (TRON_CHAIN_IDS.has(Number(chainId))) return "tron";
  if (SOLANA_CHAIN_ID_SET.has(Number(chainId))) return "solana";
  return "evm";
}

export function isTronChain(chainId: number | bigint): boolean {
  return TRON_CHAIN_IDS.has(Number(chainId));
}

export function isSolanaChain(chainId: number | bigint): boolean {
  return SOLANA_CHAIN_ID_SET.has(Number(chainId));
}

export function isSolanaMainnet(chainId: number | bigint): boolean {
  return Number(chainId) === Number(SOLANA_MAINNET_CHAIN_ID);
}

// Deliberately positive rather than `!isTronChain`: with a third chain type,
// "not Tron" no longer implies EVM, and every caller that assumed it did was
// a latent Solana bug.
export function isEvmChain(chainId: number | bigint): boolean {
  return getChainType(chainId) === "evm";
}

// Address validation and conversion live in @lifi/intent — Base58Check with
// checksum verification for Tron, raw base58 for Solana. Re-exported here for
// existing import sites.
export { isSolanaBase58Address, isTronBase58Address };

export function formatAddressForChain(address: `0x${string}`, chainId: number | bigint): string {
  if (isTronChain(chainId)) return hexToTronBase58(address);
  if (isSolanaChain(chainId)) return bytes32ToSolanaBase58(address);
  return address;
}
