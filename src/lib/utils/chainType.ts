import { TRON_MAINNET_CHAIN_ID, hexToTronBase58, isTronBase58Address } from "@lifi/intent";

export type ChainType = "evm" | "tron";

const TRON_CHAIN_IDS = new Set([Number(TRON_MAINNET_CHAIN_ID)]);

export function getChainType(chainId: number | bigint): ChainType {
  if (TRON_CHAIN_IDS.has(Number(chainId))) return "tron";
  return "evm";
}

export function isTronChain(chainId: number | bigint): boolean {
  return TRON_CHAIN_IDS.has(Number(chainId));
}

export function isEvmChain(chainId: number | bigint): boolean {
  return !isTronChain(chainId);
}

// Address validation and conversion live in @lifi/intent (Base58Check with
// checksum verification) — re-exported here for existing import sites.
export { isTronBase58Address };

export function formatAddressForChain(address: `0x${string}`, chainId: number | bigint): string {
  if (isTronChain(chainId)) return hexToTronBase58(address);
  return address;
}
