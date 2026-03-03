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
	megaeth
} from "viem/chains";

export const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000" as const;
export const BYTES32_ZERO =
	"0x0000000000000000000000000000000000000000000000000000000000000000" as const;

// --- EVM addresses --- //
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

// --- Solana addresses --- //
const solanaDevnet = defineChain({
	id: 11,
	name: "Solana Devnet",
	nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
	rpcUrls: {
		default: { http: ["https://api.devnet.solana.com"] }
	},
	testnet: true
});
// catalyst-intent-svm program IDs (devnet) — from Anchor.toml
export const SOLANA_INTENTS_PROTOCOL = "4SQaweUpT1LrRg1gh9sVEDL3Q4jZH3wxRi3qpz23SRpj" as const;
export const SOLANA_OUTPUT_SETTLER_SIMPLE = "8yt6Q3Gj8QCAqRVHQULckMf4rWSKQgN6SKVy9QTY5uWe" as const;
export const SOLANA_INPUT_SETTLER_ESCROW = "HyfCubUzStNcbAhW94PHPwRMqz2FTo9ox5HXxu2o6Ygq" as const;
export const SOLANA_POLYMER_ORACLE = "GjXkLKfMpz1MGDTFhKf31gXdcPAxPEFaEu85GmqQgLyL" as const;

// PDA(seed: "output_settler_simple") of the SOLANA_OUTPUT_SETTLER_SIMPLE program
export const SOLANA_OUTPUT_SETTLER_PDA =
	"0xfef7041ed572ebef0bcb798166b921a7691e435b9e035e2236cc225e655bc237" as const;

// --- Oracles --- ///
export const WORMHOLE_ORACLE = {
	ethereum: "0x0000000000000000000000000000000000000000",
	arbitrum: "0x0000000000000000000000000000000000000000",
	base: "0x0000000000000000000000000000000000000000"
} as const;
export const POLYMER_ORACLE = {
	ethereum: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	arbitrum: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	base: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	megaeth: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	katana: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	polygon: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	bsc: "0x0000003E06000007A224AeE90052fA6bb46d43C9",
	// testnet
	sepolia: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	baseSepolia: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	arbitrumSepolia: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	optimismSepolia: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	// PDA(seed: "polymer") of the SOLANA_POLYMER_ORACLE program
	solanaDevnet: "0xfd8c1179dcc56c06fe0e9363feadd964dd3fa13b75ce88f61dee3bfdade95af6"
} as const;

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
	polygon,
	solanaDevnet
} as const;

export const chains = Object.keys(chainMap) as (keyof typeof chainMap)[];
export type chain = (typeof chains)[number];
export const chainList = (mainnet: boolean) => {
	if (mainnet == true) {
		return ["ethereum", "base", "arbitrum", "megaeth", "katana", "polygon", "bsc", "solana"];
	} else return ["sepolia", "optimismSepolia", "baseSepolia", "arbitrumSepolia", "solanaDevnet"];
};

export type balanceQuery = Record<chain, Record<`0x${string}`, Promise<bigint>>>;

export type Token = {
	address: `0x${string}`;
	name: string;
	chain: chain;
	decimals: number;
};

export const coinList = (mainnet: boolean) => {
	if (mainnet == true)
		return [
			{
				address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
				name: "usdc",
				chain: "base",
				decimals: 6
			},
			{
				address: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`,
				name: "usdc",
				chain: "arbitrum",
				decimals: 6
			},
			{
				address: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`,
				name: "usdc",
				chain: "ethereum",
				decimals: 6
			},
			{
				address: ADDRESS_ZERO,
				name: "eth",
				chain: "base",
				decimals: 18
			},
			{
				address: ADDRESS_ZERO,
				name: "eth",
				chain: "arbitrum",
				decimals: 18
			},
			{
				address: ADDRESS_ZERO,
				name: "eth",
				chain: "ethereum",
				decimals: 18
			},
			{
				address: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`,
				name: "weth",
				chain: "ethereum",
				decimals: 18
			},
			{
				address: `0x4200000000000000000000000000000000000006`,
				name: "weth",
				chain: "base",
				decimals: 18
			},
			{
				address: `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`,
				name: "weth",
				chain: "arbitrum",
				decimals: 18
			},
			{
				address: `0x4200000000000000000000000000000000000006`,
				name: "weth",
				chain: "megaeth",
				decimals: 18
			},
			{
				address: `0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7`,
				name: "usdm",
				chain: "megaeth",
				decimals: 18
			},
			{
				address: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`,
				name: "usdc-b",
				chain: "bsc",
				decimals: 18
			},
			{
				address: `0x55d398326f99059ff775485246999027b3197955`,
				name: "usdt-b",
				chain: "bsc",
				decimals: 18
			},
			{
				address: `0x203a662b0bd271a6ed5a60edfbd04bfce608fd36`,
				name: "vbUSDC",
				chain: "katana",
				decimals: 6
			},
			{
				address: `0x7ceb23fd6bc0add59e62ac25578270cff1b9f619`,
				name: "weth",
				chain: "polygon",
				decimals: 18
			},
			{
				address: `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`,
				name: "usdc",
				chain: "polygon",
				decimals: 6
			},
			{
				address: `0x2791bca1f2de4661ed88a30c99a7a9449aa84174`,
				name: "usdc.e",
				chain: "polygon",
				decimals: 6
			}
		] as const;
	else
		return [
			{
				address: `0x5fd84259d66Cd46123540766Be93DFE6D43130D7`,
				name: "usdc",
				chain: "optimismSepolia",
				decimals: 6
			},
			{
				address: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
				name: "usdc",
				chain: "baseSepolia",
				decimals: 6
			},
			{
				address: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`,
				name: "usdc",
				chain: "sepolia",
				decimals: 6
			},
			{
				address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
				name: "usdc",
				chain: "arbitrumSepolia",
				decimals: 6
			},
			{
				address: ADDRESS_ZERO,
				name: "eth",
				chain: "sepolia",
				decimals: 18
			},
			{
				address: ADDRESS_ZERO,
				name: "eth",
				chain: "baseSepolia",
				decimals: 18
			},
			{
				address: ADDRESS_ZERO,
				name: "eth",
				chain: "optimismSepolia",
				decimals: 18
			},
			{
				address: ADDRESS_ZERO,
				name: "eth",
				chain: "arbitrumSepolia",
				decimals: 6
			},
			{
				address: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`,
				name: "weth",
				chain: "sepolia",
				decimals: 18
			},
			{
				address: `0x4200000000000000000000000000000000000006`,
				name: "weth",
				chain: "baseSepolia",
				decimals: 18
			},
			{
				address: `0x4200000000000000000000000000000000000006`,
				name: "weth",
				chain: "optimismSepolia",
				decimals: 18
			},
			{
				address: `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`,
				name: "weth",
				chain: "arbitrumSepolia",
				decimals: 18
			},
			{
				address: ADDRESS_ZERO,
				name: "sol",
				chain: "solanaDevnet",
				decimals: 9
			},
			{
				// So11111111111111111111111111111111111111112
				address: `0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001`,
				name: "wsol",
				chain: "solanaDevnet",
				decimals: 9
			},
			{
				address: `0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7`,
				name: "usdc",
				chain: "solanaDevnet",
				decimals: 6
			}
		] as const;
};

export function printToken(token: Token) {
	return `${token.name.toUpperCase()}, ${token.chain}`;
}

export function formatTokenAmount(amount: bigint, tokenDecimals: number, decimals = 4) {
	const formattedAmount = Number(amount) / 10 ** tokenDecimals;
	return formattedAmount.toFixed(decimals);
}

export function getIndexOf(token: Token) {
	for (let i = 0; i < coinList.length; ++i) {
		const elem = coinList(!chainMap[token.chain].testnet)[i];
		if (token.chain === elem.chain && token.address === elem.address) return i;
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
	polygon: polygon.id,
	solanaDevnet: solanaDevnet.id
} as const;

export type Verifier = "wormhole" | "polymer";

export function getCoin(
	args:
		| { name: string; chain: chain; address?: undefined }
		| {
				address: `0x${string}`;
				chain: chain;
				name?: undefined;
		  }
) {
	const { name = undefined, address = undefined, chain } = args;
	// ensure the address is ERC20-sized.
	const concatedAddress =
		"0x" + address?.replace("0x", "")?.slice(address.length - 42, address.length);
	for (const token of coinList(!chainMap[chain].testnet)) {
		// check chain first.
		if (token.chain === chain) {
			if (name === undefined) {
				if (concatedAddress?.toLowerCase() === token.address.toLowerCase()) return token;
			}
			if (name?.toLowerCase() === token.name.toLowerCase()) return token;
		}
	}
	return {
		name: name ?? "Unknown",
		address: address ?? ADDRESS_ZERO,
		chain,
		decimals: 1
	};
	// throw new Error(`No coins found for chain: ${concatedAddress} ${chain}`);
}

export function getChainName(chainId: number | bigint | string) {
	if (typeof chainId === "string") chainId = Number(chainId);
	if (typeof chainId === "bigint") chainId = Number(chainId);
	for (const key of chains) {
		if (chainMap[key].id === chainId) {
			return key;
		}
	}
	throw new Error(`Chain is not known: ${chainId}`);
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

export function getOracle(verifier: Verifier, chain: chain) {
	if (verifier === "polymer") return POLYMER_ORACLE[chain];
	// if (verifier === "wormhole") return (WORMHOLE_ORACLE[chain] ?? ADDRESS_ZERO);
}

export function getClient(chainId: number | bigint | string) {
	const chainName = getChainName(Number(chainId));
	if (!chainName) new Error("Could not find chain");
	const client = clients[chainName as keyof typeof clients];
	if (!client) throw new Error(`No RPC client for chain: ${chainName}`);
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
		transport: fallback([...bsc.rpcUrls.default.http.map((v) => http(v))])
	}),
	polygon: createPublicClient({
		chain: base,
		transport: fallback([...polygon.rpcUrls.default.http.map((v) => http(v))])
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

export type WC = ReturnType<
	typeof createWalletClient<ReturnType<typeof custom>, undefined, undefined, undefined>
>;
