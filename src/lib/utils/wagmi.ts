import { browser } from "$app/environment";
import { env } from "$env/dynamic/public";
import {
	connect,
	createConfig,
	disconnect,
	getConnection,
	getConnectors,
	http,
	reconnect,
	watchConnection
} from "@wagmi/core";
import { injected, metaMask, walletConnect } from "@wagmi/connectors";
import { createWalletClient, custom, type Chain, type EIP1193Provider } from "viem";
import { chainMap } from "../config";

const APP_METADATA = {
	name: "Open Intents Framework Demo",
	description: "A demo website showcasing using the Open Intents Framework. Built by LIFI.",
	url: "https://lintent.org",
	icons: ["https://lintent.org/favicon.ico"]
};

export const walletConnectProjectId = env.PUBLIC_WALLET_CONNECT_PROJECT_ID?.trim();

export function resolveConnectorIds(projectId?: string) {
	return ["injected", ...(projectId ? ["walletConnect"] : []), "metaMask"];
}

const wagmiChains = Object.values(chainMap) as Chain[];

const connectors = [
	injected(),
	...(walletConnectProjectId
		? [
				walletConnect({
					projectId: walletConnectProjectId,
					showQrModal: true,
					metadata: APP_METADATA
				})
			]
		: []),
	metaMask({ dappMetadata: APP_METADATA })
];

const transports = Object.fromEntries(wagmiChains.map((chain) => [chain.id, http()]));

export const wagmiConfig = createConfig({
	ssr: true,
	chains: wagmiChains as [Chain, ...Chain[]],
	connectors,
	transports: transports as Record<number, ReturnType<typeof http>>
});

export type WalletConnection = ReturnType<typeof getConnection>;

export function listWalletConnectors() {
	return getConnectors(wagmiConfig).map((connector) => ({
		id: connector.id,
		name: connector.name
	}));
}

export async function connectWith(connectorId: string) {
	const connector = getConnectors(wagmiConfig).find((candidate) => candidate.id === connectorId);
	if (!connector) throw new Error(`Connector not found: ${connectorId}`);
	return connect(wagmiConfig, { connector });
}

export async function reconnectWallet() {
	return reconnect(wagmiConfig);
}

export async function disconnectWallet() {
	const connection = getConnection(wagmiConfig);
	if (connection.status !== "connected") return;
	return disconnect(wagmiConfig, { connector: connection.connector });
}

export function getCurrentConnection() {
	return getConnection(wagmiConfig);
}

export async function getCurrentProvider() {
	const connection = getConnection(wagmiConfig);
	if (connection.status !== "connected") return undefined;
	return (await connection.connector.getProvider()) as EIP1193Provider;
}

export async function getCurrentWalletClient() {
	const provider = await getCurrentProvider();
	if (!provider) return undefined;
	return createWalletClient({ transport: custom(provider) });
}

export function watchWalletConnection(onChange: (connection: WalletConnection) => void) {
	if (!browser) return () => {};
	return watchConnection(wagmiConfig, {
		onChange(connection) {
			onChange(connection);
		}
	});
}
