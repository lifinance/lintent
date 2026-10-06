import {
  COIN_FILLER,
  COMPACT,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  STELLAR_MAINNET_CHAIN_ID
} from "@lifi/intent";
import { createPublicClient, createWalletClient, custom, defineChain, fallback, http } from "viem";
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
  arcTestnet
} from "viem/chains";

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
export {
  COIN_FILLER,
  COMPACT,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  MULTICHAIN_INPUT_SETTLER_ESCROW
};
export const ALWAYS_OK_ALLOCATOR = "281773970620737143753120258" as const;
export const POLYMER_ALLOCATOR = "116450367070547927622991121" as const; // 0x02ecC89C25A5DCB1206053530c58E002a737BD11 signing by 0x934244C8cd6BeBDBd0696A659D77C9BDfE86Efe6
export const WORMHOLE_ORACLE: Partial<Record<number, `0x${string}`>> = {
  [ethereum.id]: "0x0000000000000000000000000000000000000000",
  [arbitrum.id]: "0x0000000000000000000000000000000000000000",
  [base.id]: "0x0000000000000000000000000000000000000000"
};
export const POLYMER_ORACLE: Partial<Record<number, `0x${string}`>> = {
  [ethereum.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [arbitrum.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [base.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [megaeth.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
  [katana.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [polygon.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [bsc.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  [pharos.id]: "0x008C3800F3Ad9b3B662d002E90Cc00000000eE17",
  // testnet
  [sepolia.id]: "0xC401b53377b8A71A7cEB820e6a4dC53832343a90",
  [baseSepolia.id]: "0xC401b53377b8A71A7cEB820e6a4dC53832343a90",
  [arbitrumSepolia.id]: "0xC401b53377b8A71A7cEB820e6a4dC53832343a90",
  [optimismSepolia.id]: "0xC401b53377b8A71A7cEB820e6a4dC53832343a90",
  [arcTestnet.id]: "0xC401b53377b8A71A7cEB820e6a4dC53832343a90"
};

// Stellar mainnet (intent-soroban). Not a viem chain: Stellar code paths must
// branch on isStellarChain before touching chainMap/clients/getClient.
export const STELLAR_CHAIN_ID = Number(STELLAR_MAINNET_CHAIN_ID);
export const STELLAR_RPC_URL = "https://mainnet.sorobanrpc.com";
export const STELLAR_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export function isStellarChain(chainId: number | bigint | string) {
  return normalizeChainId(chainId) === STELLAR_CHAIN_ID;
}

// Axelar GMP oracles. EVM entries are addresses; the Stellar entry is the raw
// 32-byte contract id (CAVJORXN3EOHH5GGHOK66YTPBUFNICWGSAO3UBUG6SS75VSMGWIEQX4V).
export const AXELAR_ORACLE: Partial<Record<number, `0x${string}`>> = {
  [base.id]: "0xb7eA767b54aF5Dd8AD12Df648A399F9075D93FeE",
  [STELLAR_CHAIN_ID]: "0x2a9746edd91c73f4c63b95ef626f0d0ad40ac6901dba0686f4a5fed64c359048"
};
export const AXELAR_CHAIN_NAMES: Partial<Record<number, string>> = {
  [base.id]: "base",
  [STELLAR_CHAIN_ID]: "stellar"
};
// Minimum Axelar gas payment, in the SOURCE chain's base unit (wei / stroops).
export const AXELAR_GAS_FLOOR: Partial<Record<number, bigint>> = {
  [base.id]: 500000000000000n,
  [STELLAR_CHAIN_ID]: 50000000n
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
  arcTestnet
} as const;
type ChainName = keyof typeof chainMap;
export const chains = Object.keys(chainMap) as ChainName[];
export const chainList = (mainnet: boolean) => {
  if (mainnet == true) {
    return [
      "ethereum",
      "base",
      "arbitrum",
      "megaeth",
      "katana",
      "polygon",
      "bsc",
      "pharos"
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

export const chainIdList = (mainnet: boolean): number[] => {
  const ids: number[] = chainList(mainnet).map((name) => chainMap[name].id);
  return mainnet ? [...ids, STELLAR_CHAIN_ID] : ids;
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
      {
        address: `0x4200000000000000000000000000000000000006`,
        name: "weth",
        chainId: megaeth.id,
        decimals: 18
      },
      {
        address: `0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7`,
        name: "usdm",
        chainId: megaeth.id,
        decimals: 18
      },
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
        address: `0x25b4fcd859aec2fa6348438c489b3c3c10c98b6d21be4fd3cb30cb68953ef977`,
        name: "xlm",
        chainId: STELLAR_CHAIN_ID,
        decimals: 7
      },
      {
        address: `0xadefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e496`,
        name: "usdc",
        chainId: STELLAR_CHAIN_ID,
        decimals: 7
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
  arcTestnet: arcTestnet.id
} as const;

export type Verifier = "wormhole" | "polymer" | "axelar";

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
  // EVM ids are compared as 20-byte addresses (inputs may be bytes32-padded);
  // Stellar contract ids are full 32-byte values.
  const comparedAddress = isStellarChain(chainId)
    ? address
    : "0x" + address?.replace("0x", "")?.slice(address.length - 42, address.length);
  for (const token of coinList(!isChainIdTestnet(chainId))) {
    // check chain first.
    if (token.chainId === chainId) {
      if (name === undefined) {
        if (comparedAddress?.toLowerCase() === token.address.toLowerCase()) return token;
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
  if (normalized === STELLAR_CHAIN_ID) return false;
  const chain = chainById[normalized];
  if (!chain) throw new Error(`Chain is not known: ${normalized}`);
  return chain.testnet;
}

export function getChainName(chainId: number | bigint | string): ChainName | "stellar" {
  const normalized = normalizeChainId(chainId);
  if (normalized === STELLAR_CHAIN_ID) return "stellar";
  const name = chainNameById[normalized];
  if (!name) throw new Error(`Chain is not known: ${normalized}`);
  return name;
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
  if (verifier === "axelar") return AXELAR_ORACLE[normalized];
  return undefined;
}

export function getChain(chainId: number | bigint | string) {
  const normalized = normalizeChainId(chainId);
  const chain = chainById[normalized];
  if (!chain) throw new Error(`Could not find chain for chainId ${normalized}`);
  return chain;
}

export function getClient(chainId: number | bigint | string) {
  const normalized = normalizeChainId(chainId);
  const client = clientsById[normalized];
  if (!client) throw new Error(`Could not find client for chainId ${normalized}`);
  return client;
}

export const clients = {
  ethereum: createPublicClient({
    chain: ethereum,
    transport: fallback([
      http("https://ethereum-rpc.publicnode.com"),
      ...ethereum.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  arbitrum: createPublicClient({
    chain: arbitrum,
    transport: fallback([
      http("https://arbitrum-rpc.publicnode.com"),
      ...arbitrum.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  base: createPublicClient({
    chain: base,
    transport: fallback([
      http("https://base-rpc.publicnode.com"),
      ...base.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  optimism: createPublicClient({
    chain: optimism,
    transport: fallback([
      http("https://optimism-rpc.publicnode.com"),
      ...optimism.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  bsc: createPublicClient({
    chain: bsc,
    transport: fallback([
      http("https://bsc-rpc.publicnode.com"),
      ...bsc.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  polygon: createPublicClient({
    chain: base,
    transport: fallback([
      http("https://polygon-bor-rpc.publicnode.com"),
      ...polygon.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  megaeth: createPublicClient({
    chain: megaeth,
    transport: fallback([...megaeth.rpcUrls.default.http.map((v) => http(v))])
  }),
  katana: createPublicClient({
    chain: katana,
    transport: fallback([...katana.rpcUrls.default.http.map((v) => http(v))])
  }),
  pharos: createPublicClient({
    chain: pharos,
    transport: fallback([...pharos.rpcUrls.default.http.map((v) => http(v))])
  }),
  // Testnet
  sepolia: createPublicClient({
    chain: sepolia,
    transport: fallback([
      http("https://ethereum-sepolia-rpc.publicnode.com"),
      ...sepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  arbitrumSepolia: createPublicClient({
    chain: arbitrumSepolia,
    transport: fallback([
      http("https://arbitrum-sepolia-rpc.publicnode.com"),
      ...arbitrumSepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  baseSepolia: createPublicClient({
    chain: baseSepolia,
    transport: fallback([
      http("https://base-sepolia-rpc.publicnode.com"),
      ...baseSepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  optimismSepolia: createPublicClient({
    chain: optimismSepolia,
    transport: fallback([
      http("https://optimism-sepolia-rpc.publicnode.com"),
      ...optimismSepolia.rpcUrls.default.http.map((v) => http(v))
    ])
  }),
  arcTestnet: createPublicClient({
    chain: arcTestnet,
    transport: fallback([...arcTestnet.rpcUrls.default.http.map((v) => http(v))])
  })
} as const;

export const chainById = Object.fromEntries(chainEntries) as Record<
  number,
  (typeof chainMap)[keyof typeof chainMap]
>;

export const chainNameById = Object.fromEntries(chainNameEntries) as Record<number, ChainName>;

export const clientsById = Object.fromEntries(
  chains.map((name) => [chainMap[name].id, clients[name]])
) as Record<number, (typeof clients)[keyof typeof clients]>;

export type WC = ReturnType<
  typeof createWalletClient<ReturnType<typeof custom>, undefined, undefined, undefined>
>;
