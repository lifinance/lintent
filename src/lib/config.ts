import { createPublicClient, createWalletClient, custom, defineChain, fallback, http } from "viem";
import type { HttpTransport } from "viem";
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
  katana,
  megaeth,
  optimism,
  arcTestnet,
  tron
} from "viem/chains";
import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_OUTPUT_SETTLER_PDA,
  SOLANA_POLYMER_ORACLE_PDA,
  SOLANA_POLYMER_ORACLE_PROGRAM,
  TRON_MAINNET_INPUT_SETTLER,
  TRON_MAINNET_OUTPUT_SETTLER,
  TRON_MAINNET_POLYMER_ORACLE,
  solanaBase58ToBytes32,
  tronBase58ToHex
} from "@lifi/intent";
import type { ChainType } from "$lib/utils/chainType";
import { getChainType, isSolanaChain } from "$lib/utils/chainType";
const routemeshApiKey: string | undefined =
  import.meta.env?.PUBLIC_ROUTEMESH_API_KEY?.trim() || undefined;

function routemeshRpc(chainId: number): HttpTransport[] {
  if (!routemeshApiKey) return [];
  return [http(`https://lb.routeme.sh/rpc/${chainId}/${routemeshApiKey}`)];
}

export const pharos = defineChain({
  id: 1672,
  name: "Pharos",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.pharos.xyz"] }
  }
});

export const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000" as const;
export const BYTES32_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const COMPACT = "0x00000000000000171ede64904551eeDF3C6C9788" as const;
export const INPUT_SETTLER_COMPACT_LIFI = "0x0000000000cd5f7fDEc90a03a31F79E5Fbc6A9Cf" as const;
export const INPUT_SETTLER_ESCROW_LIFI = "0x00fC00edbe7C003b006f870068c548940000223e" as const;
export const MULTICHAIN_INPUT_SETTLER_ESCROW =
  "0xb912b4c38ab54b94D45Ac001484dEBcbb519Bc2B" as const;
export const MULTICHAIN_INPUT_SETTLER_COMPACT =
  "0x1fccC0807F25A58eB531a0B5b4bf3dCE88808Ed7" as const;
export const ALWAYS_OK_ALLOCATOR = "281773970620737143753120258" as const;
export const POLYMER_ALLOCATOR = "116450367070547927622991121" as const; // 0x02ecC89C25A5DCB1206053530c58E002a737BD11 signing by 0x934244C8cd6BeBDBd0696A659D77C9BDfE86Efe6
export const COIN_FILLER = "0x75220B7600c300005038432a0000f308e0000068" as const;
export { TRON_MAINNET_INPUT_SETTLER, TRON_MAINNET_OUTPUT_SETTLER };
// LI.FI solver used for the 1:1 stablecoin demo. In demo mode the quote request
// omits exclusiveFor, but the on-chain intent is still made exclusive to this
// solver so it fills 1:1 via its quick fallback.
export const DEMO_EXCLUSIVE_SOLVER = "0x94807fE4300D15909C1a4fd39f76c61D68aee11E" as const;
export const WORMHOLE_ORACLE: Partial<Record<number, `0x${string}`>> = {
  [ethereum.id]: "0x0000000000000000000000000000000000000000",
  [arbitrum.id]: "0x0000000000000000000000000000000000000000",
  [base.id]: "0x0000000000000000000000000000000000000000"
};
// The mainnet bucket points at `PolymerOracleMapped`
// (0x008C3800F3Ad9b3B662d002E90Cc00000000eE17). It inherits `ChainMap`: `_getMappedChainId`
// reverts with `ZeroValue()` for any protocol chain id that has not been mapped, so a route
// only works if the *input* chain's oracle has the *output* chain mapped. `setChainMap` is
// `onlyOwner` (0x712E90032d8f44bE276A903E1769d64dD1C7F45a) and write-once per chain.
//
// The maps are being populated chain by chain and were incomplete when last measured
// (2026-07-31 ~09:40 UTC, mappings are identity: protocolId == chainId):
//   ethereum, arbitrum, bsc  all of the chains below mapped
//   katana                   only ethereum, polygon, pharos
//   base                     only ethereum
//   polygon, pharos          nothing mapped
// Same-chain swaps are unaffected: `intent.ts` uses COIN_FILLER as `inputOracle` when
// `isSameChain()`, bypassing the oracle entirely.
//
// Re-measure before widening `coinList`/`chainList` — see the note above `chainList`.
// Addresses track `main` after SOLV-695 (#62), ported into this branch's chain-id-keyed
// shape. `main` keys this map by chain name; re-keying is why the values could not
// auto-merge — keep the two in sync by value, not by diff.
export const POLYMER_ORACLE: Partial<Record<number, `0x${string}`>> = {
  [ethereum.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [arbitrum.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [base.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  // MegaETH (4326) is not part of the mainnet deployment set: there is no code at the settler,
  // filler or oracle addresses there. Kept only to satisfy the `chain` key type; the chain is
  // disabled in `chainList`/`coinList` below, so this value is never read.
  [megaeth.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  [katana.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [polygon.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [bsc.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [pharos.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [tron.id]: TRON_MAINNET_POLYMER_ORACLE,
  // Solana: this table answers "what is the input oracle for an order
  // originating on this chain", so it holds the Polymer oracle *PDA*. The
  // value a Solana *output* carries in `MandateOutput.oracle` is a different
  // 32 bytes — the Polymer *program id*, exported below as
  // SOLANA_POLYMER_OUTPUT_ORACLE. Swapping them yields an order that fills and
  // can then never be proven. See tests/fixtures/solana/PREFLIGHT.md.
  [Number(SOLANA_MAINNET_CHAIN_ID)]: SOLANA_POLYMER_ORACLE_PDA,
  [Number(SOLANA_DEVNET_CHAIN_ID)]: SOLANA_POLYMER_ORACLE_PDA,
  // testnet — matches `main` after SOLV-695 (#62), which superseded the 0xC401b533… bucket.
  [sepolia.id]: "0xa70fE63Dd97e8e0Cb37241ed231FCBca87E99B72",
  [baseSepolia.id]: "0xa70fE63Dd97e8e0Cb37241ed231FCBca87E99B72",
  [arbitrumSepolia.id]: "0xa70fE63Dd97e8e0Cb37241ed231FCBca87E99B72",
  [optimismSepolia.id]: "0xa70fE63Dd97e8e0Cb37241ed231FCBca87E99B72",
  // Not covered by the new deployment set; left on the superseded oracle.
  [arcTestnet.id]: "0xe15b438C6267B0011aDa1e40fD8757Aa8Fe1E5a0"
};

export type availableAllocators = typeof ALWAYS_OK_ALLOCATOR | typeof POLYMER_ALLOCATOR;
export type availableInputSettlers =
  | typeof INPUT_SETTLER_COMPACT_LIFI
  | typeof INPUT_SETTLER_ESCROW_LIFI;

export const chainMap = {
  ethereum,
  base,
  arbitrum,
  optimism,
  sepolia,
  arbitrumSepolia,
  optimismSepolia,
  baseSepolia,
  katana,
  megaeth,
  bsc,
  polygon,
  pharos,
  arcTestnet,
  tron
} as const;
type ChainName = keyof typeof chainMap;
export const chains = Object.keys(chainMap) as ChainName[];
// Output-chain selector. MegaETH is omitted because `OutputSettlerSimple` is not deployed there,
// so it cannot settle a fill. Every other chain here is a valid destination from the origin chains
// `coinList` offers — see the chain-map notes above `POLYMER_ORACLE`.
export const chainList = (mainnet: boolean) => {
  if (mainnet == true) {
    return [
      "ethereum",
      "base",
      "arbitrum",
      "katana",
      "polygon",
      "bsc",
      "pharos",
      "tron"
    ] as ChainName[];
  } else
    return [
      "sepolia",
      "optimismSepolia",
      "baseSepolia",
      "arbitrumSepolia",
      "arcTestnet"
    ] as ChainName[];
};

export const chainIdList = (mainnet: boolean) => {
  const evm = chainList(mainnet).map((name) => chainMap[name].id);
  // Solana is not in `chainMap` (see the ChainMeta note below), so it is
  // appended here. Both clusters run the same deployment, verified on chain:
  // see the "Verified on chain" table in tests/fixtures/solana/PREFLIGHT.md.
  return [...evm, Number(mainnet ? SOLANA_MAINNET_CHAIN_ID : SOLANA_DEVNET_CHAIN_ID)];
};

const chainEntries = chains.map((name) => [chainMap[name].id, chainMap[name]] as const);
const chainNameEntries = chains.map((name) => [chainMap[name].id, name] as const);

export type balanceQuery = Record<number, Record<`0x${string}`, Promise<bigint>>>;

export type Token = {
  address: `0x${string}`;
  name: string;
  chainId: number;
  decimals: number;
};

export const coinList = (mainnet: boolean) => {
  if (mainnet == true)
    return [
      {
        address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
        name: "usdc",
        chainId: base.id,
        decimals: 6
      },
      {
        address: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`,
        name: "usdc",
        chainId: arbitrum.id,
        decimals: 6
      },
      {
        address: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`,
        name: "usdc",
        chainId: ethereum.id,
        decimals: 6
      },
      {
        address: ADDRESS_ZERO,
        name: "eth",
        chainId: base.id,
        decimals: 18
      },
      {
        address: ADDRESS_ZERO,
        name: "eth",
        chainId: arbitrum.id,
        decimals: 18
      },
      {
        address: ADDRESS_ZERO,
        name: "eth",
        chainId: ethereum.id,
        decimals: 18
      },
      {
        address: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`,
        name: "weth",
        chainId: ethereum.id,
        decimals: 18
      },
      {
        address: `0x82106347dDbB23cE44Cf4cE4053Ef1adf8b9323B`,
        name: "wmton",
        chainId: ethereum.id,
        decimals: 18
      },
      {
        address: `0x4200000000000000000000000000000000000006`,
        name: "weth",
        chainId: base.id,
        decimals: 18
      },
      {
        address: `0x4200000000000000000000000000000000000006`,
        name: "weth",
        chainId: optimism.id,
        decimals: 18
      },
      {
        address: `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`,
        name: "weth",
        chainId: arbitrum.id,
        decimals: 18
      },
      // MegaETH tokens removed: no InputSettlerEscrowLIFI / OutputSettlerSimple deployed on
      // chain 4326, so neither leg of an intent can execute there.
      {
        address: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`,
        name: "usdc-b",
        chainId: bsc.id,
        decimals: 18
      },
      {
        address: `0x55d398326f99059ff775485246999027b3197955`,
        name: "usdt-b",
        chainId: bsc.id,
        decimals: 18
      },
      {
        address: `0x203a662b0bd271a6ed5a60edfbd04bfce608fd36`,
        name: "vbUSDC",
        chainId: katana.id,
        decimals: 6
      },
      {
        address: `0x7ceb23fd6bc0add59e62ac25578270cff1b9f619`,
        name: "weth",
        chainId: polygon.id,
        decimals: 18
      },
      {
        address: `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`,
        name: "usdc",
        chainId: polygon.id,
        decimals: 6
      },
      {
        address: `0x2791bca1f2de4661ed88a30c99a7a9449aa84174`,
        name: "usdc.e",
        chainId: polygon.id,
        decimals: 6
      },
      {
        address: tronBase58ToHex("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
        name: "usdt",
        chainId: tron.id,
        decimals: 6
      },
      {
        address: tronBase58ToHex("TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8"),
        name: "usdc",
        chainId: tron.id,
        decimals: 6
      },
      {
        address: ADDRESS_ZERO,
        name: "trx",
        chainId: tron.id,
        decimals: 6
      },
      {
        address: `0xc879c018db60520f4355c26ed1a6d572cdac1815`,
        name: "usdc",
        chainId: pharos.id,
        decimals: 6
      },
      // Solana mainnet. Mints stored as 32-byte hex, like the devnet entries
      // below — `Token.address` is the app's internal identity, and `getCoin`
      // compares Solana addresses whole rather than truncating to 20 bytes.
      //
      // Decimals and owning program read from mainnet on 2026-08-13: all three
      // are legacy SPL Token (not Token-2022).
      {
        // EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
        address: solanaBase58ToBytes32("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        name: "usdc",
        chainId: Number(SOLANA_MAINNET_CHAIN_ID),
        decimals: 6
      },
      {
        // Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
        address: solanaBase58ToBytes32("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
        name: "usdt",
        chainId: Number(SOLANA_MAINNET_CHAIN_ID),
        decimals: 6
      },
      {
        // Wrapped SOL. Native SOL is a valid OUTPUT via `native_fill` but never
        // an input — the escrow's `open` has no native path — so wSOL is what
        // an order can actually deposit.
        address: solanaBase58ToBytes32("So11111111111111111111111111111111111111112"),
        name: "wsol",
        chainId: Number(SOLANA_MAINNET_CHAIN_ID),
        decimals: 9
      }
    ] as const;
  else
    return [
      {
        address: `0x5fd84259d66Cd46123540766Be93DFE6D43130D7`,
        name: "usdc",
        chainId: optimismSepolia.id,
        decimals: 6
      },
      {
        address: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
        name: "usdc",
        chainId: baseSepolia.id,
        decimals: 6
      },
      {
        address: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`,
        name: "usdc",
        chainId: sepolia.id,
        decimals: 6
      },
      {
        address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
        name: "usdc",
        chainId: arbitrumSepolia.id,
        decimals: 6
      },
      {
        address: ADDRESS_ZERO,
        name: "eth",
        chainId: sepolia.id,
        decimals: 18
      },
      {
        address: ADDRESS_ZERO,
        name: "eth",
        chainId: baseSepolia.id,
        decimals: 18
      },
      {
        address: ADDRESS_ZERO,
        name: "eth",
        chainId: optimismSepolia.id,
        decimals: 18
      },
      {
        address: ADDRESS_ZERO,
        name: "eth",
        chainId: arbitrumSepolia.id,
        decimals: 6
      },
      {
        address: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`,
        name: "weth",
        chainId: sepolia.id,
        decimals: 18
      },
      {
        address: `0x4200000000000000000000000000000000000006`,
        name: "weth",
        chainId: baseSepolia.id,
        decimals: 18
      },
      {
        address: `0x4200000000000000000000000000000000000006`,
        name: "weth",
        chainId: optimismSepolia.id,
        decimals: 18
      },
      {
        address: `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`,
        name: "weth",
        chainId: arbitrumSepolia.id,
        decimals: 18
      },
      {
        address: `0x3600000000000000000000000000000000000000`,
        name: "usdc",
        chainId: arcTestnet.id,
        decimals: 6
      },
      // Solana devnet. Mints are stored as 32-byte hex, not base58, because
      // `Token.address` is the app's internal identity everywhere — `getCoin`
      // compares Solana addresses whole rather than truncating to 20 bytes.
      //
      // Devnet only for now: mainnet Solana is deliberately absent from
      // `coinList` and `chainIdList` until the live checks in
      // tests/fixtures/solana/PREFLIGHT.md pass and a small-value canary has
      // settled end to end.
      {
        // 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
        address: solanaBase58ToBytes32("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
        name: "usdc",
        chainId: Number(SOLANA_DEVNET_CHAIN_ID),
        decimals: 6
      },
      {
        // Wrapped SOL. Native SOL (the zero mint) is a valid OUTPUT via
        // `native_fill`, but never an input: the escrow's `open` has no
        // native path, so wSOL is what an order can actually deposit.
        address: solanaBase58ToBytes32("So11111111111111111111111111111111111111112"),
        name: "wsol",
        chainId: Number(SOLANA_DEVNET_CHAIN_ID),
        decimals: 9
      }
    ] as const;
};

export function printToken(token: Token) {
  return `${token.name.toUpperCase()}, ${getChainName(token.chainId)}`;
}

export function formatTokenAmount(amount: bigint, tokenDecimals: number, decimals = 4) {
  const formattedAmount = Number(amount) / 10 ** tokenDecimals;
  return formattedAmount.toFixed(decimals);
}

export function getIndexOf(token: Token) {
  const coins = coinList(!isChainIdTestnet(token.chainId));
  for (let i = 0; i < coins.length; ++i) {
    const elem = coins[i];
    if (token.chainId === elem.chainId && token.address === elem.address) return i;
  }
  return -1;
}

export type coin = ReturnType<typeof coinList>[number]["address"];

export const wormholeChainIds = {
  sepolia: 10002,
  arbitrumSepolia: 10003,
  baseSepolia: 10004,
  optimismSepolia: 10005
} as const;
export const polymerChainIds = {
  ethereum: ethereum.id,
  base: base.id,
  arbitrum: arbitrum.id,
  sepolia: sepolia.id,
  arbitrumSepolia: arbitrumSepolia.id,
  baseSepolia: baseSepolia.id,
  optimismSepolia: optimismSepolia.id,
  optimism: optimism.id,
  megaeth: megaeth.id,
  katana: katana.id,
  bsc: bsc.id,
  polygon: polygon.id,
  pharos: pharos.id,
  arcTestnet: arcTestnet.id,
  tron: tron.id
} as const;

export type Verifier = "wormhole" | "polymer";

export function getCoin(
  args:
    | { name: string; chainId: number | bigint | string; address?: undefined }
    | {
        address: `0x${string}`;
        chainId: number | bigint | string;
        name?: undefined;
      }
) {
  const { name = undefined, address = undefined } = args;
  const chainId = normalizeChainId(args.chainId);
  // EVM and Tron token ids are uint256-widened 20-byte addresses, so the low
  // 20 bytes are the address. Solana mints are genuinely 32 bytes — truncating
  // one would match the wrong token (or nothing) — so compare them whole.
  const concatedAddress = isSolanaChain(chainId)
    ? address
    : "0x" + address?.replace("0x", "")?.slice(address.length - 42, address.length);
  for (const token of coinList(!isChainIdTestnet(chainId))) {
    // check chain first.
    if (token.chainId === chainId) {
      if (name === undefined) {
        if (concatedAddress?.toLowerCase() === token.address.toLowerCase()) return token;
      }
      if (name?.toLowerCase() === token.name.toLowerCase()) return token;
    }
  }
  return {
    name: name ?? "Unknown",
    address: address ?? ADDRESS_ZERO,
    chainId,
    decimals: 1
  };
  // throw new Error(`No coins found for chain: ${concatedAddress} ${chain}`);
}

function normalizeChainId(chainId: number | bigint | string) {
  if (typeof chainId === "string") return Number(chainId);
  if (typeof chainId === "bigint") return Number(chainId);
  return chainId;
}

export function isChainIdTestnet(chainId: number | bigint | string) {
  const normalized = normalizeChainId(chainId);
  const meta = chainMetaById[normalized];
  if (!meta) throw new Error(`Chain is not known: ${normalized}`);
  return meta.testnet;
}

export function getChainName(chainId: number | bigint | string) {
  const normalized = normalizeChainId(chainId);
  const meta = chainMetaById[normalized];
  if (!meta) throw new Error(`Chain is not known: ${normalized}`);
  return meta.name;
}

export function formatTokenDecimals(
  value: bigint | number,
  coin: Token,
  as: "number" | "string" = "string"
) {
  const decimals = coin.decimals;
  const result = Number(value) / 10 ** decimals;
  return as === "string" ? result.toString() : result;
}

export function getOracle(verifier: Verifier, chainId: number | bigint | string) {
  const normalized = normalizeChainId(chainId);
  if (verifier === "polymer") return POLYMER_ORACLE[normalized];
  if (verifier === "wormhole") return WORMHOLE_ORACLE[normalized];
  return undefined;
}

// Deliberately EVM-only: both return viem values that have no non-EVM
// analogue. Callers handling a Tron or Solana chain must branch on chain type
// BEFORE reaching these — the error names the chain type so a missing branch
// is obvious from the message rather than surfacing as "chain not found".
export function getChain(chainId: number | bigint | string) {
  const normalized = normalizeChainId(chainId);
  const chain = chainById[normalized];
  if (!chain) throw new Error(`${describeNonEvmChain(normalized)} (getChain)`);
  return chain;
}

export function getClient(chainId: number | bigint | string) {
  const normalized = normalizeChainId(chainId);
  const client = clientsById[normalized];
  if (!client) throw new Error(`${describeNonEvmChain(normalized)} (getClient)`);
  return client;
}

function describeNonEvmChain(normalized: number) {
  const type = getChainType(normalized);
  if (type !== "evm") {
    return `Chain ${normalized} is a ${type} chain, not an EVM chain — callers must branch on chain type`;
  }
  return `Could not find chain for chainId ${normalized}`;
}

export const clients = {
  ethereum: createPublicClient({
    chain: ethereum,
    transport: fallback([
      ...routemeshRpc(ethereum.id),
      http("https://ethereum-rpc.publicnode.com"),
      ...ethereum.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  arbitrum: createPublicClient({
    chain: arbitrum,
    transport: fallback([
      ...routemeshRpc(arbitrum.id),
      http("https://arbitrum-rpc.publicnode.com"),
      ...arbitrum.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  base: createPublicClient({
    chain: base,
    transport: fallback([
      ...routemeshRpc(base.id),
      http("https://base-rpc.publicnode.com"),
      ...base.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  optimism: createPublicClient({
    chain: optimism,
    transport: fallback([
      ...routemeshRpc(optimism.id),
      http("https://optimism-rpc.publicnode.com"),
      ...optimism.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  bsc: createPublicClient({
    chain: bsc,
    transport: fallback([
      ...routemeshRpc(bsc.id),
      http("https://bsc-rpc.publicnode.com"),
      http("https://bsc-dataseed.bnbchain.org"),
      http("https://bsc-dataseed1.defibit.io"),
      http("https://bsc.drpc.org"),
      http("https://1rpc.io/bnb"),
      ...bsc.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  polygon: createPublicClient({
    chain: base,
    transport: fallback([
      ...routemeshRpc(polygon.id),
      http("https://polygon-bor-rpc.publicnode.com"),
      ...polygon.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  megaeth: createPublicClient({
    chain: megaeth,
    transport: fallback([
      ...routemeshRpc(megaeth.id),
      ...megaeth.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  katana: createPublicClient({
    chain: katana,
    transport: fallback([
      ...routemeshRpc(katana.id),
      ...katana.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  pharos: createPublicClient({
    chain: pharos,
    transport: fallback([...pharos.rpcUrls.default.http.map((v) => http(v))])
  }),
  // Testnet
  sepolia: createPublicClient({
    chain: sepolia,
    transport: fallback([
      ...routemeshRpc(sepolia.id),
      http("https://ethereum-sepolia-rpc.publicnode.com"),
      ...sepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  arbitrumSepolia: createPublicClient({
    chain: arbitrumSepolia,
    transport: fallback([
      ...routemeshRpc(arbitrumSepolia.id),
      http("https://arbitrum-sepolia-rpc.publicnode.com"),
      ...arbitrumSepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  baseSepolia: createPublicClient({
    chain: baseSepolia,
    transport: fallback([
      ...routemeshRpc(baseSepolia.id),
      http("https://base-sepolia-rpc.publicnode.com"),
      ...baseSepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  optimismSepolia: createPublicClient({
    chain: optimismSepolia,
    transport: fallback([
      ...routemeshRpc(optimismSepolia.id),
      http("https://optimism-sepolia-rpc.publicnode.com"),
      ...optimismSepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  arcTestnet: createPublicClient({
    chain: arcTestnet,
    transport: fallback([
      ...routemeshRpc(arcTestnet.id),
      ...arcTestnet.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  tron: createPublicClient({
    chain: tron,
    transport: fallback([
      ...routemeshRpc(tron.id),
      ...tron.rpcUrls.default.http.map((v) => http(v, { retryCount: 0 }))
    ]),
    batch: { multicall: false }
  })
} as const;

export const chainById = Object.fromEntries(chainEntries) as Record<
  number,
  (typeof chainMap)[keyof typeof chainMap]
>;

export const chainNameById = Object.fromEntries(chainNameEntries) as Record<number, ChainName>;

// Non-EVM chains deliberately stay OUT of `chainMap`. `chainMap` feeds
// `wagmiChains` in utils/wagmi.ts — a Solana entry there would show up in
// every wallet's switch-chain menu — and `clientsById`, which would build a
// viem public client with an EVM JSON-RPC transport pointed at a Solana RPC:
// a client that type-checks and then fails at runtime. The `pharos` precedent
// does not apply; Pharos is a real EVM chain with a real JSON-RPC endpoint.
//
// Instead, everything that is genuinely chain-agnostic — display name, testnet
// flag, chain type — lives in this parallel registry, and the viem-only
// accessors (`getChain`, `getClient`) keep throwing for non-EVM ids so callers
// are forced to branch.
/**
 * The value `MandateOutput.oracle` must hold for a Solana OUTPUT — the Polymer
 * *program id*, not the oracle PDA in `POLYMER_ORACLE` above.
 * `oracle_polymer::submit` compares the fill's LocalAttestation consumer
 * against its own program id.
 */
export const SOLANA_POLYMER_OUTPUT_ORACLE = SOLANA_POLYMER_ORACLE_PROGRAM;

/** The value `MandateOutput.settler` must hold for a Solana output. */
export const SOLANA_OUTPUT_SETTLER = SOLANA_OUTPUT_SETTLER_PDA;

export type ChainMeta = {
  id: number;
  name: string;
  testnet: boolean;
  type: ChainType;
};

export const SOLANA_CHAIN_META: readonly ChainMeta[] = [
  {
    id: Number(SOLANA_MAINNET_CHAIN_ID),
    name: "solana",
    testnet: false,
    type: "solana"
  },
  {
    id: Number(SOLANA_DEVNET_CHAIN_ID),
    name: "solanaDevnet",
    testnet: true,
    type: "solana"
  }
];

export const chainMetaById: Record<number, ChainMeta> = {
  ...Object.fromEntries(
    chains.map((name) => [
      chainMap[name].id,
      {
        id: chainMap[name].id,
        name,
        testnet: Boolean(chainMap[name].testnet),
        type: getChainType(chainMap[name].id)
      } satisfies ChainMeta
    ])
  ),
  ...Object.fromEntries(SOLANA_CHAIN_META.map((meta) => [meta.id, meta]))
};

export const clientsById = Object.fromEntries(
  chains.map((name) => [chainMap[name].id, clients[name]])
) as Record<number, (typeof clients)[keyof typeof clients]>;

export type WC = ReturnType<
  typeof createWalletClient<ReturnType<typeof custom>, undefined, undefined, undefined>
>;
