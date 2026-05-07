import { defineChain } from "viem";
import { Connection } from "@solana/web3.js";
import {
  SOLANA_MAINNET_CHAIN_ID as INTENT_SOLANA_MAINNET_CHAIN_ID,
  SOLANA_DEVNET_CHAIN_ID as INTENT_SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_OUTPUT_SETTLER_PDA as INTENT_SOLANA_MAINNET_OUTPUT_SETTLER_PDA,
} from "@lifi/intent";
import { getEvmChain } from "./evm";
import type { SvmToken } from "../../types/svm";

// ---------------------------------------------------------------------------
// Solana program IDs (base58) — used for Anchor / @solana/web3.js PublicKey
// Source: catalyst-intent-svm/Anchor.toml (devnet) and on-chain deployments
// (mainnet). Not exported from @lifi/intent because it carries bytes32 forms,
// not Solana-runtime base58 IDs.
// ---------------------------------------------------------------------------

export const SOLANA_DEVNET_INTENTS_PROTOCOL =
  "3uhp8xScxF8FH3XtK13cLPjzp6xhu4vSgLSfntwFijrL";
export const SOLANA_DEVNET_OUTPUT_SETTLER_SIMPLE =
  "ELEtkk6aBjexKxAbMHd8S9236wMpt785n142sMH9YSWa";
export const SOLANA_DEVNET_INPUT_SETTLER_ESCROW =
  "Amx9xngT2J5156cf1iMdF1BfJFwoDu8Je6Qv2zH14V5c";
export const SOLANA_DEVNET_POLYMER_ORACLE =
  "81qeg9TPZ7eYkz8TdRSsMmedbEJ6xPC3Y1a8hgfy1PCn";

const SOLANA_MAINNET_INTENTS_PROTOCOL =
  "3uhp8xScxF8FH3XtK13cLPjzp6xhu4vSgLSfntwFijrL";
const SOLANA_MAINNET_OUTPUT_SETTLER_SIMPLE =
  "ELEtkk6aBjexKxAbMHd8S9236wMpt785n142sMH9YSWa";
const SOLANA_MAINNET_INPUT_SETTLER_ESCROW =
  "Amx9xngT2J5156cf1iMdF1BfJFwoDu8Je6Qv2zH14V5c";
const SOLANA_MAINNET_POLYMER_ORACLE =
  "81qeg9TPZ7eYkz8TdRSsMmedbEJ6xPC3Y1a8hgfy1PCn";

// ---------------------------------------------------------------------------
// PDA addresses (bytes32 hex) — used in MandateOutput.settler / .oracle
// Output-settler PDAs come from @lifi/intent so encoded mandate outputs match
// what the intent library would produce on its own. Polymer PDAs are not in
// @lifi/intent.
// ---------------------------------------------------------------------------

export const SOLANA_DEVNET_OUTPUT_SETTLER_PDA =
  "0x57e93c230b75ab3ad76e89157ae3ce486fbe4ae4c4ac120882ccf2fdfb88a8bf" as const;

/** PDA(seed: "polymer", program: SOLANA_DEVNET_POLYMER_ORACLE) */
export const POLYMER_ORACLE_PDA =
  "0x15eb012f9aa7dd107100bed641e1f2519388fca494c754fe8738bc4d844cb353" as const;

const SOLANA_MAINNET_OUTPUT_SETTLER_PDA =
  "0x57e93c230b75ab3ad76e89157ae3ce486fbe4ae4c4ac120882ccf2fdfb88a8bf" as const;
const SOLANA_MAINNET_POLYMER_ORACLE_PDA =
  "0x15eb012f9aa7dd107100bed641e1f2519388fca494c754fe8738bc4d844cb353" as const;

// ---------------------------------------------------------------------------
// Grouped program / PDA objects
// ---------------------------------------------------------------------------

export const SOLANA_DEVNET_PROGRAMS = {
  INTENTS_PROTOCOL: SOLANA_DEVNET_INTENTS_PROTOCOL,
  OUTPUT_SETTLER_SIMPLE: SOLANA_DEVNET_OUTPUT_SETTLER_SIMPLE,
  INPUT_SETTLER_ESCROW: SOLANA_DEVNET_INPUT_SETTLER_ESCROW,
  POLYMER_ORACLE: SOLANA_DEVNET_POLYMER_ORACLE,
} as const;

export const SOLANA_DEVNET_PDAS = {
  OUTPUT_SETTLER: SOLANA_DEVNET_OUTPUT_SETTLER_PDA,
  POLYMER_ORACLE: POLYMER_ORACLE_PDA,
} as const;

export const SOLANA_MAINNET_PROGRAMS = {
  INTENTS_PROTOCOL: SOLANA_MAINNET_INTENTS_PROTOCOL,
  OUTPUT_SETTLER_SIMPLE: SOLANA_MAINNET_OUTPUT_SETTLER_SIMPLE,
  INPUT_SETTLER_ESCROW: SOLANA_MAINNET_INPUT_SETTLER_ESCROW,
  POLYMER_ORACLE: SOLANA_MAINNET_POLYMER_ORACLE,
} as const;

export const SOLANA_MAINNET_PDAS = {
  OUTPUT_SETTLER: SOLANA_MAINNET_OUTPUT_SETTLER_PDA,
  POLYMER_ORACLE: SOLANA_MAINNET_POLYMER_ORACLE_PDA,
} as const;

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

export type SolanaNetwork = "devnet" | "mainnet";

export function getSolanaNetwork(mainnet: boolean): SolanaNetwork {
  return mainnet ? "mainnet" : "devnet";
}

export function getSolanaPrograms(
  network: SolanaNetwork,
): typeof SOLANA_DEVNET_PROGRAMS | typeof SOLANA_MAINNET_PROGRAMS {
  return network === "mainnet" ? SOLANA_MAINNET_PROGRAMS : SOLANA_DEVNET_PROGRAMS;
}

type SolanaPdas = {
  readonly OUTPUT_SETTLER: `0x${string}`;
  readonly POLYMER_ORACLE: `0x${string}`;
};

export function getSolanaPdas(network: SolanaNetwork): SolanaPdas {
  return network === "mainnet" ? SOLANA_MAINNET_PDAS : SOLANA_DEVNET_PDAS;
}

// ---------------------------------------------------------------------------
// Chain IDs
// Derived from @lifi/intent's bigint chain IDs to keep the cross-package
// values in sync. Viem expects `number` for `defineChain.id`.
// ---------------------------------------------------------------------------

export const SOLANA_DEVNET_VIEM_CHAIN_ID = Number(
  INTENT_SOLANA_DEVNET_CHAIN_ID,
);
export const SOLANA_MAINNET_VIEM_CHAIN_ID = Number(
  INTENT_SOLANA_MAINNET_CHAIN_ID,
);

// ---------------------------------------------------------------------------
// Viem chain definitions
// ---------------------------------------------------------------------------

export const solanaDevnetViemChain = defineChain({
  id: SOLANA_DEVNET_VIEM_CHAIN_ID,
  name: "Solana Devnet",
  nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
  rpcUrls: { default: { http: ["https://api.devnet.solana.com"] } },
  testnet: true,
});

export const solanaMainnetViemChain = defineChain({
  id: SOLANA_MAINNET_VIEM_CHAIN_ID,
  name: "Solana",
  nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
  rpcUrls: { default: { http: ["https://api.mainnet-beta.solana.com"] } },
});

export const SOLANA_DEVNET_INTENTS_CHAIN_ID = 11 as const;
export const SOLANA_MAINNET_INTENTS_CHAIN_ID = 10 as const;

export function getSvmViemChainId(mainnet: boolean): number {
  return mainnet ? SOLANA_MAINNET_VIEM_CHAIN_ID : SOLANA_DEVNET_VIEM_CHAIN_ID;
}

export function getSvmIntentsChainId(mainnet: boolean): number {
  return mainnet
    ? SOLANA_MAINNET_INTENTS_CHAIN_ID
    : SOLANA_DEVNET_INTENTS_CHAIN_ID;
}

export function isSolanaViemChainId(chainId: number | bigint): boolean {
  const id = Number(chainId);
  return (
    id === SOLANA_DEVNET_VIEM_CHAIN_ID || id === SOLANA_MAINNET_VIEM_CHAIN_ID
  );
}

/** Human-readable chain label including the numeric id, e.g. "Base Sepolia (84532)". */
export function formatChainLabel(chainId: number | bigint): string {
  const id = Number(chainId);
  if (id === SOLANA_MAINNET_VIEM_CHAIN_ID) return `Solana (${id})`;
  if (id === SOLANA_DEVNET_VIEM_CHAIN_ID) return `Solana Devnet (${id})`;
  try {
    return `${getEvmChain(id).name} (${id})`;
  } catch {
    return `Chain ${id}`;
  }
}

// ---------------------------------------------------------------------------
// RPC / Connection
// ---------------------------------------------------------------------------

const SOLANA_DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";
const SOLANA_MAINNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_MAINNET_RPC ??
  `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`;

let _devnetConn: Connection | undefined;
let _mainnetConn: Connection | undefined;

export function getSolanaRpcUrl(mainnet: boolean): string {
  return mainnet ? SOLANA_MAINNET_RPC : SOLANA_DEVNET_RPC;
}

export function getSolanaConnection(mainnet: boolean): Connection {
  if (mainnet) {
    _mainnetConn ??= new Connection(SOLANA_MAINNET_RPC, "confirmed");
    return _mainnetConn;
  }
  _devnetConn ??= new Connection(SOLANA_DEVNET_RPC, "confirmed");
  return _devnetConn;
}

// ---------------------------------------------------------------------------
// Token lists
// ---------------------------------------------------------------------------

const SVM_DEVNET_TOKENS: SvmToken[] = [
  {
    mintAddress: "So11111111111111111111111111111111111111112",
    bytes32Address:
      "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    name: "wSOL",
    decimals: 9,
  },
  {
    mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    bytes32Address:
      "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7",
    name: "USDC",
    decimals: 6,
  },
];

const SVM_MAINNET_TOKENS: SvmToken[] = [
  {
    mintAddress: "So11111111111111111111111111111111111111112",
    bytes32Address:
      "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    name: "wSOL",
    decimals: 9,
  },
  {
    mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    bytes32Address:
      "0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61",
    name: "USDC",
    decimals: 6,
  },
];

const NATIVE_SOL_TOKEN: SvmToken = {
  mintAddress: "",
  bytes32Address:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  name: "SOL",
  decimals: 9,
};

export function getSvmTokens(mainnet: boolean): SvmToken[] {
  const list = mainnet ? SVM_MAINNET_TOKENS : SVM_DEVNET_TOKENS;
  return [NATIVE_SOL_TOKEN, ...list];
}

export function getSvmTokenByBytes32(
  bytes32Address: string,
  mainnet = false,
): SvmToken | undefined {
  return getSvmTokens(mainnet).find((t) => t.bytes32Address === bytes32Address);
}
