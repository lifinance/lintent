import { TRON_MAINNET_CHAIN_ID } from "@lifi/intent";

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

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function hexToTronBase58(hex: `0x${string}`): string {
  if (typeof window !== "undefined" && window.tronWeb) {
    return window.tronWeb.address.fromHex("0x" + hex.replace("0x", ""));
  }
  // Fallback: Base58 encode with 0x41 prefix (without checksum — display only)
  const addressHex = "41" + hex.replace("0x", "");
  return encodeBase58(hexToBytes(addressHex));
}

export function isTronBase58Address(value: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
}

export function formatAddressForChain(address: `0x${string}`, chainId: number | bigint): string {
  if (isTronChain(chainId)) return hexToTronBase58(address);
  return address;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function encodeBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }
  let result = "";
  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = BASE58_ALPHABET[remainder] + result;
  }
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}
