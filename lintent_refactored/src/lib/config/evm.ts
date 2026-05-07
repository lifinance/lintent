import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet as ethereum,
  optimismSepolia,
  sepolia,
  polygon,
  bsc,
} from "viem/chains";
import { createPublicClient, http, defineChain, type Chain } from "viem";
import { ADDRESS_ZERO } from "./shared";
import type { EvmToken } from "../../types/evm";

// Re-export EVM constants from the intent library so app code has a single import source.
export {
  COMPACT,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  COIN_FILLER,
} from "@lifi/intent";

// Custom chains
export const katana = defineChain({
  id: 747,
  name: "Katana",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.katanarpc.com"] } },
});

export const megaeth = defineChain({
  id: 6342,
  name: "MegaETH Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://carrot.megaeth.com/rpc"] } },
  testnet: true,
});

// Re-export viem chains for use in wagmi config
export {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  ethereum,
  optimismSepolia,
  sepolia,
  polygon,
  bsc,
};

// App-specific allocator IDs (not in the intent library)
export const ALWAYS_OK_ALLOCATOR = "281773970620737143753120258" as const;
export const POLYMER_ALLOCATOR = "116450367070547927622991121" as const;

// Polymer oracle addresses by chain id
export const POLYMER_ORACLE: Record<number, `0x${string}`> = {
  [ethereum.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  [arbitrum.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  // Base mainnet — verified 2026-04-28 against on-chain
  // chainIdMap(2) = 1151111081099710 (canonical OIF Solana mainnet ID).
  [base.id]: "0x3a8054ea5Cca4e403b7C942054cC9BD6A71D2b3f",
  [megaeth.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  [katana.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  [polygon.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  [bsc.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  // Polymer oracle (testnet) — verified 2026-04-28 against on-chain
  // chainIdMap(2) returning 1151111081099712 (canonical OIF Solana devnet ID).
  // The previous address `0xeba99…f3A7` used a legacy mapping (2 → 11) and
  // breaks finalise. Polymer redeployed under this CREATE2 address.
  [sepolia.id]: "0xa056B481CD36eE61b0C417403A1d48aF481378b3",
  [baseSepolia.id]: "0xa056B481CD36eE61b0C417403A1d48aF481378b3",
  [arbitrumSepolia.id]: "0xa056B481CD36eE61b0C417403A1d48aF481378b3",
  [optimismSepolia.id]: "0xa056B481CD36eE61b0C417403A1d48aF481378b3",
};

export const WORMHOLE_ORACLE: Record<number, `0x${string}`> = {
  [ethereum.id]: "0x0000000000000000000000000000000000000000",
  [arbitrum.id]: "0x0000000000000000000000000000000000000000",
  [base.id]: "0x0000000000000000000000000000000000000000",
};

export const EVM_MAINNET_CHAINS = [
  ethereum,
  base,
  arbitrum,
  megaeth,
  katana,
  polygon,
  bsc,
] as const;
export const EVM_TESTNET_CHAINS = [
  sepolia,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
] as const;

export function getEvmChains(mainnet: boolean): Chain[] {
  return mainnet ? [...EVM_MAINNET_CHAINS] : [...EVM_TESTNET_CHAINS];
}

export const EVM_MAINNET_TOKENS: EvmToken[] = [
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USDC",
    chainId: base.id,
    decimals: 6,
  },
  {
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    name: "USDC",
    chainId: arbitrum.id,
    decimals: 6,
  },
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    name: "USDC",
    chainId: ethereum.id,
    decimals: 6,
  },
  { address: ADDRESS_ZERO, name: "ETH", chainId: base.id, decimals: 18 },
  { address: ADDRESS_ZERO, name: "ETH", chainId: arbitrum.id, decimals: 18 },
  { address: ADDRESS_ZERO, name: "ETH", chainId: ethereum.id, decimals: 18 },
  {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    name: "WETH",
    chainId: ethereum.id,
    decimals: 18,
  },
  {
    address: "0x4200000000000000000000000000000000000006",
    name: "WETH",
    chainId: base.id,
    decimals: 18,
  },
  {
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    name: "WETH",
    chainId: arbitrum.id,
    decimals: 18,
  },
  {
    address: "0x4200000000000000000000000000000000000006",
    name: "WETH",
    chainId: megaeth.id,
    decimals: 18,
  },
  {
    address: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
    name: "USDM",
    chainId: megaeth.id,
    decimals: 18,
  },
  {
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    name: "USDC-B",
    chainId: bsc.id,
    decimals: 18,
  },
  {
    address: "0x55d398326f99059ff775485246999027b3197955",
    name: "USDT-B",
    chainId: bsc.id,
    decimals: 18,
  },
  {
    address: "0x203a662b0bd271a6ed5a60edfbd04bfce608fd36",
    name: "vbUSDC",
    chainId: katana.id,
    decimals: 6,
  },
  {
    address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    name: "WETH",
    chainId: polygon.id,
    decimals: 18,
  },
  {
    address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    name: "USDC",
    chainId: polygon.id,
    decimals: 6,
  },
];

export const EVM_TESTNET_TOKENS: EvmToken[] = [
  {
    address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    name: "USDC",
    chainId: optimismSepolia.id,
    decimals: 6,
  },
  {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    chainId: baseSepolia.id,
    decimals: 6,
  },
  {
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    name: "USDC",
    chainId: sepolia.id,
    decimals: 6,
  },
  {
    address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    name: "USDC",
    chainId: arbitrumSepolia.id,
    decimals: 6,
  },
  { address: ADDRESS_ZERO, name: "ETH", chainId: sepolia.id, decimals: 18 },
  { address: ADDRESS_ZERO, name: "ETH", chainId: baseSepolia.id, decimals: 18 },
  {
    address: ADDRESS_ZERO,
    name: "ETH",
    chainId: optimismSepolia.id,
    decimals: 18,
  },
  {
    address: ADDRESS_ZERO,
    name: "ETH",
    chainId: arbitrumSepolia.id,
    decimals: 18,
  },
  {
    address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    name: "WETH",
    chainId: sepolia.id,
    decimals: 18,
  },
  {
    address: "0x4200000000000000000000000000000000000006",
    name: "WETH",
    chainId: baseSepolia.id,
    decimals: 18,
  },
  {
    address: "0x4200000000000000000000000000000000000006",
    name: "WETH",
    chainId: optimismSepolia.id,
    decimals: 18,
  },
  {
    address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    name: "WETH",
    chainId: arbitrumSepolia.id,
    decimals: 18,
  },
];

export function getEvmTokens(mainnet: boolean): EvmToken[] {
  return mainnet ? EVM_MAINNET_TOKENS : EVM_TESTNET_TOKENS;
}

export function getEvmTokensForChain(
  chainId: number,
  mainnet: boolean,
): EvmToken[] {
  return getEvmTokens(mainnet).filter((t) => t.chainId === chainId);
}

const ALL_CHAINS: Chain[] = [
  ethereum,
  arbitrum,
  base,
  megaeth,
  katana,
  polygon,
  bsc,
  sepolia,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
];

export function getEvmChain(chainId: number | bigint): Chain {
  const id = Number(chainId);
  const chain = ALL_CHAINS.find((c) => c.id === id);
  if (!chain) throw new Error(`Unknown EVM chain id: ${id}`);
  return chain;
}

export function getEvmClient(
  chainId: number | bigint,
): ReturnType<typeof createPublicClient> {
  const chain = getEvmChain(chainId);
  return createPublicClient({ chain, transport: http() });
}
