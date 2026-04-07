import { createPublicClient, createWalletClient, custom, defineChain, fallback, http } from "viem";
import { Connection } from "@solana/web3.js";
import {
	SOLANA_MAINNET_CHAIN_ID,
	SOLANA_TESTNET_CHAIN_ID,
	SOLANA_DEVNET_CHAIN_ID
} from "@lifi/intent";
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
// All three Solana chain IDs as numbers (all values are < 2^53, safe as JS numbers)
export const SOLANA_MAINNET_CHAIN_ID_NUM = Number(SOLANA_MAINNET_CHAIN_ID);
export const SOLANA_TESTNET_CHAIN_ID_NUM = Number(SOLANA_TESTNET_CHAIN_ID);
export const SOLANA_DEVNET_CHAIN_ID_NUM = Number(SOLANA_DEVNET_CHAIN_ID);
export const SOLANA_CHAIN_IDS = new Set([
	SOLANA_MAINNET_CHAIN_ID_NUM,
	SOLANA_TESTNET_CHAIN_ID_NUM,
	SOLANA_DEVNET_CHAIN_ID_NUM
]);

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const SOLANA_TESTNET_RPC = "https://api.testnet.solana.com";

export const solanaMainnet = defineChain({
	id: SOLANA_MAINNET_CHAIN_ID_NUM,
	name: "Solana",
	nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
	rpcUrls: { default: { http: [SOLANA_MAINNET_RPC] } }
});
export const solanaTestnet = defineChain({
	id: SOLANA_TESTNET_CHAIN_ID_NUM,
	name: "Solana Testnet",
	nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
	rpcUrls: { default: { http: [SOLANA_TESTNET_RPC] } },
	testnet: true
});
export const solanaDevnet = defineChain({
	id: SOLANA_DEVNET_CHAIN_ID_NUM,
	name: "Solana Devnet",
	nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
	rpcUrls: { default: { http: [SOLANA_DEVNET_RPC] } },
	testnet: true
});

const _solanaDevnetConn = new Connection(SOLANA_DEVNET_RPC, "confirmed");
const _solanaMainnetConn = new Connection(SOLANA_MAINNET_RPC, "confirmed");

export function getSolanaConnection(chainId: number | bigint): Connection {
	const id = Number(chainId);
	if (id === solanaMainnet.id) return _solanaMainnetConn;
	if (id === solanaDevnet.id) return _solanaDevnetConn;
	throw new Error(
		`No Solana connection configured for chain ID ${id}. Solana testnet is not supported.`
	);
}

export function isSolanaChain(chainId: number | bigint): boolean {
	return SOLANA_CHAIN_IDS.has(Number(chainId));
}

// catalyst-intent-svm program IDs, keyed by network
export const SOLANA_PROGRAMS: {
	devnet: Record<string, string>;
	mainnet: Record<string, string | null>;
} = {
	devnet: {
		// from Anchor.toml
		INTENTS_PROTOCOL: "H1dVz9YXVys8c4tAihD14M5jnrUQi1MFsA65YQ92oCCz",
		OUTPUT_SETTLER_SIMPLE: "58CsNaufL383JL7J1jafGW4eWgeQFX5vSZssjsk4WKXd",
		INPUT_SETTLER_ESCROW: "5QngyaYhNscSebqV4DwYQhk333p5CMP8A9yyLX3pPyXC",
		POLYMER_ORACLE: "C2rAFLS6xQ78t18rK5s9madY9fztbhTaHwShgYtzonk7"
	},
	mainnet: {
		// Mainnet program IDs are not yet deployed. Remove solanaMainnet from chainList(true)
		// until these are filled in and re-tested.
		INTENTS_PROTOCOL: null,
		OUTPUT_SETTLER_SIMPLE: null,
		INPUT_SETTLER_ESCROW: null,
		POLYMER_ORACLE: null
	}
};

/** Throws a descriptive error when a mainnet Solana program ID is accessed before deployment. */
export function requireSolanaProgram(id: string | null, name: string): string {
	if (id === null)
		throw new Error(
			`Solana mainnet program "${name}" is not deployed yet. Update SOLANA_PROGRAMS.mainnet and re-test before enabling mainnet.`
		);
	return id;
}

// Derived PDAs, keyed by network
export const SOLANA_PDAS = {
	devnet: {
		// PDA(seed: "output_settler_simple", program: SOLANA_PROGRAMS.devnet.OUTPUT_SETTLER_SIMPLE)
		OUTPUT_SETTLER:
			"0xabb04f05c412a4892f8c93efa4eda9f360ba8b5c8342bed51207c7a4fdd036d6" as `0x${string}`,
		// PDA(seed: "polymer", program: SOLANA_PROGRAMS.devnet.POLYMER_ORACLE)
		POLYMER_ORACLE:
			"0xe48a6f95df84c28a030f60ba5b74e4a02922a4a5724c9633109f089b2287edfc" as `0x${string}`
	},
	mainnet: {
		OUTPUT_SETTLER: BYTES32_ZERO,
		POLYMER_ORACLE: BYTES32_ZERO
	}
} as const;

// Flat exports for use throughout the codebase
export const SOLANA_INTENTS_PROTOCOL = SOLANA_PROGRAMS.devnet.INTENTS_PROTOCOL;
export const SOLANA_OUTPUT_SETTLER_SIMPLE = SOLANA_PROGRAMS.devnet.OUTPUT_SETTLER_SIMPLE;
export const SOLANA_INPUT_SETTLER_ESCROW = SOLANA_PROGRAMS.devnet.INPUT_SETTLER_ESCROW;
export const SOLANA_POLYMER_ORACLE = SOLANA_PROGRAMS.devnet.POLYMER_ORACLE;
export const SOLANA_OUTPUT_SETTLER_PDA = SOLANA_PDAS.devnet.OUTPUT_SETTLER;

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
	[optimismSepolia.id]: "0x00d5b500ECa100F7cdeDC800eC631Aca00BaAC00",
	[SOLANA_DEVNET_CHAIN_ID_NUM]: SOLANA_PDAS.devnet.POLYMER_ORACLE
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
	polygon,
	solanaMainnet,
	solanaTestnet,
	solanaDevnet
} as const;
type ChainName = keyof typeof chainMap;
export const chains = Object.keys(chainMap) as ChainName[];
export const chainList = (mainnet: boolean): ChainName[] => {
	if (mainnet) {
		// solanaMainnet omitted until SOLANA_PROGRAMS.mainnet are deployed and tested.
		return ["ethereum", "base", "arbitrum", "megaeth", "katana", "polygon", "bsc"];
	} else {
		return [
			"sepolia",
			"optimismSepolia",
			"baseSepolia",
			"arbitrumSepolia",
			"solanaTestnet",
			"solanaDevnet"
		];
	}
};

export const chainIdList = (mainnet: boolean) =>
	chainList(mainnet).map((name) => chainMap[name].id) as number[];

const chainEntries = chains.map((name) => [chainMap[name].id, chainMap[name]] as const);
const chainNameEntries = chains.map((name) => [chainMap[name].id, name] as const);

export type balanceQuery = Record<number, Record<`0x${string}`, Promise<bigint>>>;

export type Token = {
	address: `0x${string}`;
	name: string;
	chainId: number;
	decimals: number;
};

export const coinList = (mainnet: boolean): Token[] => {
	if (mainnet)
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
			},
			// Solana devnet — SPL mint addresses encoded as bytes32 (66 chars); ADDRESS_ZERO = native SOL
			{ address: ADDRESS_ZERO, name: "sol", chainId: SOLANA_DEVNET_CHAIN_ID_NUM, decimals: 9 },
			{
				address: `0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7`,
				name: "usdc",
				chainId: SOLANA_DEVNET_CHAIN_ID_NUM,
				decimals: 6
			}
		];
};

export const evmCoinList = (mainnet: boolean) =>
	coinList(mainnet).filter((t) => !!evmClientsById[t.chainId]);

export const solanaCoinList = (mainnet: boolean) =>
	coinList(mainnet).filter((t) => SOLANA_CHAIN_IDS.has(t.chainId));

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
	// For Solana chains, the token address is a full 32-byte pubkey (66-char hex) — compare directly.
	// For EVM chains, the address may arrive as a bytes32 left-padded with zeros — slice to 20 bytes.
	const isSolanaChain = SOLANA_CHAIN_IDS.has(chainId);
	const concatedAddress = isSolanaChain
		? address?.toLowerCase()
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
	const chain = chainById[normalized];
	if (!chain) throw new Error(`Chain is not known: ${normalized}`);
	return chain.testnet ?? false;
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
	const client = evmClientsById[normalized];
	if (!client) throw new Error(`Could not find client for chainId ${normalized}`);
	return client;
}

export const evmClients = {
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
		chain: polygon,
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

export const chainById = {
	...Object.fromEntries(chainEntries),
	[solanaMainnet.id]: solanaMainnet,
	[solanaTestnet.id]: solanaTestnet,
	[solanaDevnet.id]: solanaDevnet
} as Record<number, (typeof chainMap)[keyof typeof chainMap] | typeof solanaMainnet>;

export const chainNameById = {
	...Object.fromEntries(chainNameEntries),
	[solanaMainnet.id]: "solana",
	[solanaTestnet.id]: "solana-testnet",
	[solanaDevnet.id]: "solana-devnet"
} as Record<number, string>;

export const evmClientsById = Object.fromEntries(
	(Object.keys(evmClients) as (keyof typeof evmClients)[]).map((name) => [
		chainMap[name].id,
		evmClients[name]
	])
) as Record<number, (typeof evmClients)[keyof typeof evmClients]>;

export type WC = ReturnType<
	typeof createWalletClient<ReturnType<typeof custom>, undefined, undefined, undefined>
>;
