import type { Page } from "@playwright/test";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import type { Hex } from "viem";
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";

type ProviderPayload = {
	method: string;
	params?: unknown[];
};

function ensureEnvLoaded() {
	const envFilePath = process.env.E2E_ENV_FILE?.trim() || ".env";
	loadDotenv({ path: envFilePath, quiet: true });
}

ensureEnvLoaded();

function getE2EEnv(name: string) {
	return process.env[name]?.trim();
}

export const hasE2EPrivateKey = Boolean(getE2EEnv("E2E_PRIVATE_KEY"));

const BASE_CHAIN_ID = base.id;
const ARBITRUM_CHAIN_ID = arbitrum.id;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ERC20_BALANCE_OF_ABI = [
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }]
	}
] as const;
const baseRpcUrl = getE2EEnv("E2E_BASE_RPC_URL") || "https://base-rpc.publicnode.com";
const arbitrumRpcUrl = getE2EEnv("E2E_ARBITRUM_RPC_URL") || "https://arbitrum-rpc.publicnode.com";

let accountCache: ReturnType<typeof privateKeyToAccount> | undefined;
let walletClientByChainCache: Record<number, ReturnType<typeof createWalletClient>> | undefined;
let basePublicClientCache: ReturnType<typeof createPublicClient> | undefined;

function rpcUrlForChain(chainId: number): string {
	if (chainId === BASE_CHAIN_ID) return baseRpcUrl;
	if (chainId === ARBITRUM_CHAIN_ID) return arbitrumRpcUrl;
	throw new Error(`Unsupported chain for E2E wallet provider: ${chainId}`);
}

function getWalletContext() {
	const configuredPrivateKey = getE2EEnv("E2E_PRIVATE_KEY") as Hex | undefined;
	if (!configuredPrivateKey) {
		throw new Error("E2E_PRIVATE_KEY is required for E2E wallet injection.");
	}

	const account = (accountCache ??= privateKeyToAccount(configuredPrivateKey));
	const walletClientByChain =
		walletClientByChainCache ??
		(walletClientByChainCache = {
			[BASE_CHAIN_ID]: createWalletClient({
				account,
				chain: base,
				transport: http(baseRpcUrl)
			}),
			[ARBITRUM_CHAIN_ID]: createWalletClient({
				account,
				chain: arbitrum,
				transport: http(arbitrumRpcUrl)
			})
		});
	return { account, walletClientByChain };
}

function activeWalletClient() {
	const { walletClientByChain } = getWalletContext();
	const walletClient = walletClientByChain[currentChainId];
	if (!walletClient) {
		throw new Error(`No wallet client configured for active chain ${currentChainId}.`);
	}
	return walletClient;
}

let currentChainId = Number(process.env.E2E_CHAIN_ID ?? BASE_CHAIN_ID);
if (!Number.isFinite(currentChainId)) {
	currentChainId = BASE_CHAIN_ID;
}

async function rpcRequest(method: string, params: unknown[] = []) {
	const response = await fetch(rpcUrlForChain(currentChainId), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Date.now(),
			method,
			params
		})
	});
	const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
	if (payload.error) {
		throw new Error(payload.error.message ?? `RPC error for method ${method}`);
	}
	return payload.result;
}

function asBigInt(value: unknown): bigint | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return BigInt(value);
}

async function handleProviderRequest(payload: ProviderPayload) {
	const { account } = getWalletContext();
	const { method, params = [] } = payload;

	if (method === "eth_chainId") return toHex(currentChainId);
	if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
	if (method === "wallet_switchEthereumChain") {
		const nextChainHex = (params[0] as { chainId?: string } | undefined)?.chainId;
		if (!nextChainHex) throw new Error("wallet_switchEthereumChain missing chainId");
		currentChainId = Number(BigInt(nextChainHex));
		return null;
	}

	if (method === "eth_sendTransaction") {
		const walletClient = activeWalletClient();
		const tx = (params[0] as Record<string, unknown> | undefined) ?? {};
		return await walletClient.sendTransaction({
			account,
			to: tx.to as Hex | undefined,
			data: tx.data as Hex | undefined,
			value: asBigInt(tx.value),
			gas: asBigInt(tx.gas),
			maxFeePerGas: asBigInt(tx.maxFeePerGas),
			maxPriorityFeePerGas: asBigInt(tx.maxPriorityFeePerGas)
		});
	}

	if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
		const rawTypedData = params[1];
		const typedData =
			typeof rawTypedData === "string"
				? (JSON.parse(rawTypedData) as Record<string, unknown>)
				: ((rawTypedData ?? {}) as Record<string, unknown>);
		const types = { ...(typedData.types as Record<string, unknown>) };
		delete (types as Record<string, unknown>).EIP712Domain;
		return account.signTypedData({
			domain: (typedData.domain as Record<string, unknown>) ?? {},
			types: types as Record<string, readonly unknown[]>,
			primaryType: typedData.primaryType as string,
			message: (typedData.message as Record<string, unknown>) ?? {}
		} as never);
	}

	if (method === "personal_sign") {
		const message = params[0];
		if (typeof message === "string" && message.startsWith("0x")) {
			return account.signMessage({ message: { raw: message as Hex } });
		}
		return account.signMessage({ message: String(message ?? "") });
	}

	return rpcRequest(method, params);
}

export async function installInjectedWalletProvider(page: Page) {
	getWalletContext();

	await page.exposeFunction("__lintentE2EProviderRequest", (payload: ProviderPayload) => {
		return handleProviderRequest(payload);
	});

	await page.addInitScript(() => {
		type E2EWindow = Window &
			typeof globalThis & {
				__lintentE2EProviderRequest: (payload: {
					method: string;
					params?: unknown[];
				}) => Promise<unknown>;
				__LINTENT_E2E_PROVIDER__?: unknown;
				ethereum?: unknown;
			};
		const e2eWindow = window as E2EWindow;

		const listeners = new Map<string, Set<(value: unknown) => void>>();
		const emit = (event: string, value: unknown) => {
			const set = listeners.get(event);
			if (!set) return;
			for (const listener of set) listener(value);
		};

		const provider = {
			isMetaMask: false,
			request: async ({ method, params }: { method: string; params?: unknown[] }) => {
				const result = await e2eWindow.__lintentE2EProviderRequest({
					method,
					params: params ?? []
				});

				if (method === "eth_requestAccounts") emit("accountsChanged", result);
				if (method === "wallet_switchEthereumChain") {
					const nextChain = (params?.[0] as { chainId?: string } | undefined)?.chainId;
					if (nextChain) emit("chainChanged", nextChain);
				}

				return result;
			},
			enable: async () => {
				return await provider.request({ method: "eth_requestAccounts", params: [] });
			},
			on: (event: string, callback: (value: unknown) => void) => {
				const set = listeners.get(event) ?? new Set<(value: unknown) => void>();
				set.add(callback);
				listeners.set(event, set);
			},
			removeListener: (event: string, callback: (value: unknown) => void) => {
				listeners.get(event)?.delete(callback);
			},
			off: (event: string, callback: (value: unknown) => void) => {
				listeners.get(event)?.delete(callback);
			}
		};

		e2eWindow.__LINTENT_E2E_PROVIDER__ = provider;
		e2eWindow.ethereum = provider;
	});
}

export async function connectInjectedWallet(page: Page) {
	await page.getByRole("button", { name: "Connect Injected" }).click();
}

export function e2eWalletAddress() {
	const { account } = getWalletContext();
	return account.address;
}

export async function hasBaseUsdcBalance(minimumRawAmount: bigint) {
	const { account } = getWalletContext();
	const basePublicClient =
		basePublicClientCache ??
		(basePublicClientCache = createPublicClient({
			chain: base,
			transport: http(baseRpcUrl)
		}));

	const balance = await basePublicClient.readContract({
		address: BASE_USDC,
		abi: ERC20_BALANCE_OF_ABI,
		functionName: "balanceOf",
		args: [account.address]
	});
	return balance >= minimumRawAmount;
}

export async function bootstrapConnectedWallet(page: Page) {
	await installInjectedWalletProvider(page);
	await page.goto("/");
	await connectInjectedWallet(page);
}
