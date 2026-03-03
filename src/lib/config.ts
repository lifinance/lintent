import { createPublicClient, createWalletClient, custom, fallback, http } from "viem";
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
	megaeth
} from "viem/chains";

export const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000" as const;
export const BYTES32_ZERO =
	"0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const COMPACT = "0x00000000000000171ede64904551eeDF3C6C9788" as const;
export const INPUT_SETTLER_COMPACT_LIFI = "0x0000000000cd5f7fDEc90a03a31F79E5Fbc6A9Cf" as const;
export const INPUT_SETTLER_ESCROW_LIFI = "0x000025c3226C00B2Cdc200005a1600509f4e00C0" as const;
export const MULTICHAIN_INPUT_SETTLER_ESCROW =
	"0xb912b4c38ab54b94D45Ac001484dEBcbb519Bc2B" as const;
export const MULTICHAIN_INPUT_SETTLER_COMPACT =
	"0x1fccC0807F25A58eB531a0B5b4bf3dCE88808Ed7" as const;
export const ALWAYS_OK_ALLOCATOR = "281773970620737143753120258" as const;
export const POLYMER_ALLOCATOR = "116450367070547927622991121" as const; // 0x02ecC89C25A5DCB1206053530c58E002a737BD11 signing by 0x934244C8cd6BeBDBd0696A659D77C9BDfE86Efe6
export const COIN_FILLER = "0x0000000000eC36B683C2E6AC89e9A75989C22a2e" as const;
export const WORMHOLE_ORACLE: Partial<Record<number, `0x${string}`>> = {
	[ethereum.id]: "0x0000000000000000000000000000000000000000",
	[arbitrum.id]: "0x0000000000000000000000000000000000000000",
	[base.id]: "0x0000000000000000000000000000000000000000"
};
export const POLYMER_ORACLE: Partial<Record<number, `0x${string}`>> = {
	[ethereum.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	[arbitrum.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	[base.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	[megaeth.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	[katana.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	[polygon.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	[bsc.id]: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	// testnet
	[sepolia.id]: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	[baseSepolia.id]: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	[arbitrumSepolia.id]: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	[optimismSepolia.id]: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00"
};

export type availableAllocators = typeof ALWAYS_OK_ALLOCATOR | typeof POLYMER_ALLOCATOR;
export type availableInputSettlers =
	| typeof INPUT_SETTLER_COMPACT_LIFI
	| typeof INPUT_SETTLER_ESCROW_LIFI;

export const chainMap = {
	ethereum,
	base,
	arbitrum,
	sepolia,
	arbitrumSepolia,
	optimismSepolia,
	baseSepolia,
	katana,
	megaeth,
	bsc,
	polygon
} as const;
type ChainName = keyof typeof chainMap;
export const chains = Object.keys(chainMap) as ChainName[];
export const chainList = (mainnet: boolean) => {
	if (mainnet == true) {
		return ["ethereum", "base", "arbitrum", "megaeth", "katana", "polygon", "bsc"] as ChainName[];
	} else return ["sepolia", "optimismSepolia", "baseSepolia", "arbitrumSepolia"] as ChainName[];
};

export const chainIdList = (mainnet: boolean) => {
	return chainList(mainnet).map((name) => chainMap[name].id);
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
				address: `0x4200000000000000000000000000000000000006`,
				name: "weth",
				chainId: base.id,
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
	megaeth: megaeth.id,
	katana: katana.id,
	bsc: bsc.id,
	polygon: polygon.id
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
	// ensure the address is ERC20-sized.
	const concatedAddress =
		"0x" + address?.replace("0x", "")?.slice(address.length - 42, address.length);
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
	const chain = chainById[normalized];
	if (!chain) throw new Error(`Chain is not known: ${normalized}`);
	return chain.testnet;
}

export function getChainName(chainId: number | bigint | string) {
	const normalized = normalizeChainId(chainId);
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
