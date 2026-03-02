import type { OrderContainer } from "@lifi/intent";
import type { AppTokenContext } from "./appTypes";
import {
	ALWAYS_OK_ALLOCATOR,
	clientsById,
	coinList,
	COMPACT,
	INPUT_SETTLER_COMPACT_LIFI,
	INPUT_SETTLER_ESCROW_LIFI,
	MULTICHAIN_INPUT_SETTLER_COMPACT,
	MULTICHAIN_INPUT_SETTLER_ESCROW,
	type availableAllocators,
	type Token,
	type Verifier,
	type WC
} from "./config";
import { getAllowance, getBalance, getCompactBalance } from "./libraries/token";
import { browser } from "$app/environment";
import { initDb, db } from "./db";
import {
	intents,
	fillTransactions as fillTransactionsTable,
	transactionReceipts as transactionReceiptsTable
} from "./schema";
import { and, eq } from "drizzle-orm";
import { orderToIntent } from "@lifi/intent";
import { getOrFetchRpc, invalidateRpcPrefix } from "./libraries/rpcCache";
import {
	getCurrentConnection,
	getCurrentWalletClient,
	reconnectWallet,
	type WalletConnection,
	watchWalletConnection
} from "./utils/wagmi";
import { switchWalletChain } from "./utils/walletClientRuntime";

class Store {
	mainnet = $state<boolean>(true);
	orders = $state<OrderContainer[]>([]);

	async loadOrdersFromDb() {
		if (!browser) return;
		if (!db) await initDb();
		if (!db) return;
		const rows = await db!.select().from(intents);
		this.orders = rows.map((r: any) => JSON.parse(r.data) as OrderContainer);
	}

	async saveOrderToDb(order: OrderContainer) {
		if (!browser) return;
		if (!db) await initDb();
		const orderId = orderToIntent(order).orderId();
		const now = Math.floor(Date.now() / 1000);
		const id =
			(order as any).id ?? (typeof crypto !== "undefined" ? crypto.randomUUID() : String(now));
		const intentType = (order as any).intentType ?? "escrow";
		const data = JSON.stringify(order);
		if (db) {
			try {
				try {
					await db
						.insert(intents)
						.values({
							id,
							orderId,
							intentType,
							data,
							createdAt: now
						})
						.onConflictDoUpdate({
							target: intents.orderId,
							set: { intentType, data }
						});
				} catch (_error) {
					const existing = await db.select().from(intents).where(eq(intents.orderId, orderId));
					if (existing.length > 0) {
						await db.update(intents).set({ intentType, data }).where(eq(intents.orderId, orderId));
					} else {
						await db.insert(intents).values({
							id,
							orderId,
							intentType,
							data,
							createdAt: now
						});
					}
				}
			} catch (error) {
				console.warn("saveOrderToDb db write failed", { orderId, error });
			}
		}
		const idx = this.orders.findIndex((o) => orderToIntent(o).orderId() === orderId);
		if (idx >= 0) this.orders[idx] = order;
		else this.orders.push(order);
	}

	async deleteOrderFromDb(orderId: string) {
		if (!browser) return;
		if (!db) await initDb();
		if (!db) return;
		await db!.delete(intents).where(eq(intents.orderId, orderId));
		await this.loadOrdersFromDb();
	}

	async loadFillTransactionsFromDb() {
		if (!browser) return;
		if (!db) await initDb();
		if (!db) return;
		const rows = await db!.select().from(fillTransactionsTable);
		const loaded: { [outputId: string]: `0x${string}` } = {};
		for (const row of rows) loaded[row.outputHash] = row.txHash as `0x${string}`;
		this.fillTransactions = loaded;
	}

	async saveFillTransaction(outputHash: string, txHash: `0x${string}`) {
		if (!browser) return;
		if (!db) await initDb();
		if (!db) return;
		const existing = await db!
			.select()
			.from(fillTransactionsTable)
			.where(eq(fillTransactionsTable.outputHash, outputHash));
		if (existing.length > 0) {
			await db!
				.update(fillTransactionsTable)
				.set({ txHash })
				.where(eq(fillTransactionsTable.outputHash, outputHash));
		} else {
			await db!.insert(fillTransactionsTable).values({
				id: typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now()),
				outputHash,
				txHash
			});
		}
	}

	async loadTransactionReceiptsFromDb() {
		if (!browser) return;
		if (!db) await initDb();
		if (!db) return;
		const rows = await db!.select().from(transactionReceiptsTable);
		const loaded: Record<string, string> = {};
		for (const row of rows) {
			loaded[`${row.chainId}:${row.txHash}`] = row.receipt;
		}
		this.transactionReceipts = loaded;
	}

	async saveTransactionReceipt(chainId: number | bigint, txHash: `0x${string}`, receipt: unknown) {
		if (!browser) return;
		if (!db) await initDb();
		if (!db) return;
		const chainIdNumber = Number(chainId);
		const serializedReceipt = JSON.stringify(receipt, (_key, value) =>
			typeof value === "bigint" ? value.toString() : value
		);
		const existing = await db!
			.select()
			.from(transactionReceiptsTable)
			.where(
				and(
					eq(transactionReceiptsTable.chainId, chainIdNumber),
					eq(transactionReceiptsTable.txHash, txHash)
				)
			);
		if (existing.length > 0) {
			await db!
				.update(transactionReceiptsTable)
				.set({ receipt: serializedReceipt })
				.where(
					and(
						eq(transactionReceiptsTable.chainId, chainIdNumber),
						eq(transactionReceiptsTable.txHash, txHash)
					)
				);
		} else {
			await db!.insert(transactionReceiptsTable).values({
				id: typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now()),
				chainId: chainIdNumber,
				txHash,
				receipt: serializedReceipt,
				createdAt: Math.floor(Date.now() / 1000)
			});
		}
		this.transactionReceipts[`${chainIdNumber}:${txHash}`] = serializedReceipt;
	}

	getTransactionReceipt(chainId: number | bigint, txHash: `0x${string}`) {
		const serialized = this.transactionReceipts[`${Number(chainId)}:${txHash}`];
		if (!serialized) return undefined;
		try {
			return JSON.parse(serialized) as unknown;
		} catch (error) {
			console.warn("parse cached transaction receipt failed", {
				chainId: Number(chainId),
				txHash,
				error
			});
			return undefined;
		}
	}

	walletConnection = $state<WalletConnection>(getCurrentConnection());
	connectedAccount = $derived(
		this.walletConnection.status === "connected"
			? { address: this.walletConnection.address }
			: undefined
	);
	walletClient = $state<WC>(undefined as unknown as WC);
	_unwatchWalletConnection?: () => void;

	inputTokens = $state<AppTokenContext[]>([]);
	outputTokens = $state<AppTokenContext[]>([]);
	fillTransactions = $state<{ [outputId: string]: `0x${string}` }>({});
	transactionReceipts = $state<Record<string, string>>({});

	refreshEpoch = $state(0);
	rpcRefreshMs = 45_000;
	_rpcRefreshHandle?: ReturnType<typeof setInterval>;

	balances = $derived.by(() => {
		this.refreshEpoch;
		const account = this.connectedAccount?.address;
		return this.mapOverCoinsCached({
			bucket: "balance",
			ttlMs: 30_000,
			isMainnet: this.mainnet,
			scopeKey: account ?? "none",
			fetcher: (asset, client) => getBalance(account, asset, client)
		});
	});

	allowances = $derived.by(() => {
		this.refreshEpoch;
		const account = this.connectedAccount?.address;
		const spender =
			this.inputSettler === INPUT_SETTLER_COMPACT_LIFI ||
			this.inputSettler === MULTICHAIN_INPUT_SETTLER_COMPACT
				? COMPACT
				: this.inputSettler;
		return this.mapOverCoinsCached({
			bucket: "allowance",
			ttlMs: 60_000,
			isMainnet: this.mainnet,
			scopeKey: `${account ?? "none"}:${spender}`,
			fetcher: (asset, client) => getAllowance(spender)(account, asset, client)
		});
	});

	compactBalances = $derived.by(() => {
		this.refreshEpoch;
		const account = this.connectedAccount?.address;
		const allocatorId = this.allocatorId;
		return this.mapOverCoinsCached({
			bucket: "compact",
			ttlMs: 60_000,
			isMainnet: this.mainnet,
			scopeKey: `${account ?? "none"}:${allocatorId}`,
			fetcher: (asset, client) => getCompactBalance(account, asset, client, allocatorId)
		});
	});

	multichain = $derived([...new Set(this.inputTokens.map((i) => i.token.chainId))].length > 1);

	inputSettler = $derived.by(() => {
		if (this.intentType === "escrow" && !this.multichain) return INPUT_SETTLER_ESCROW_LIFI;
		if (this.intentType === "escrow" && this.multichain) return MULTICHAIN_INPUT_SETTLER_ESCROW;
		if (this.intentType === "compact" && !this.multichain) return INPUT_SETTLER_COMPACT_LIFI;
		if (this.intentType === "compact" && this.multichain) return MULTICHAIN_INPUT_SETTLER_COMPACT;
		return INPUT_SETTLER_ESCROW_LIFI;
	});
	intentType = $state<"escrow" | "compact">("escrow");
	allocatorId = $state<availableAllocators>(ALWAYS_OK_ALLOCATOR);
	verifier = $state<Verifier>("polymer");
	recipient: string = $state("");
	exclusiveFor: string = $state("");
	useExclusiveForQuoteRequest = $state(false);

	invalidateWalletReadCache(scope: "all" | "balance" | "allowance" | "compact" = "all") {
		if (scope === "all" || scope === "balance") invalidateRpcPrefix("balance:");
		if (scope === "all" || scope === "allowance") invalidateRpcPrefix("allowance:");
		if (scope === "all" || scope === "compact") invalidateRpcPrefix("compact:");
	}

	refreshWalletReads(opts?: {
		force?: boolean;
		scope?: "all" | "balance" | "allowance" | "compact";
	}) {
		const force = opts?.force ?? false;
		const scope = opts?.scope ?? "all";
		if (force) this.invalidateWalletReadCache(scope);
		this.refreshEpoch += 1;
	}

	refreshTokenBalance(token: Token, force = true) {
		if (force) {
			invalidateRpcPrefix(
				`balance:${this.mainnet ? "mainnet" : "testnet"}:${token.chainId}:${token.address}:`
			);
		}
		this.refreshEpoch += 1;
	}

	refreshTokenAllowance(token: Token, force = true) {
		if (force) {
			invalidateRpcPrefix(
				`allowance:${this.mainnet ? "mainnet" : "testnet"}:${token.chainId}:${token.address}:`
			);
		}
		this.refreshEpoch += 1;
	}

	refreshCompactBalance(token: Token, force = true) {
		if (force) {
			invalidateRpcPrefix(
				`compact:${this.mainnet ? "mainnet" : "testnet"}:${token.chainId}:${token.address}:`
			);
		}
		this.refreshEpoch += 1;
	}

	forceUpdate = () => {
		this.refreshWalletReads({ force: true, scope: "all" });
	};

	syncIntervalMs = 5000;
	_syncHandle?: ReturnType<typeof setInterval>;

	startSync(intervalMs?: number) {
		this.stopSync();
		this._syncHandle = setInterval(() => {
			this.loadOrdersFromDb().catch((e) => console.warn("sync error", e));
		}, intervalMs ?? this.syncIntervalMs);
	}

	stopSync() {
		if (this._syncHandle) {
			clearInterval(this._syncHandle);
			this._syncHandle = undefined;
		}
	}

	startRpcRefreshLoop(intervalMs?: number) {
		if (!browser) return;
		this.stopRpcRefreshLoop();
		this._rpcRefreshHandle = setInterval(() => {
			this.refreshWalletReads();
		}, intervalMs ?? this.rpcRefreshMs);
	}

	stopRpcRefreshLoop() {
		if (this._rpcRefreshHandle) {
			clearInterval(this._rpcRefreshHandle);
			this._rpcRefreshHandle = undefined;
		}
	}

	async syncWalletClient() {
		if (this.walletConnection.status !== "connected") {
			this.walletClient = undefined as unknown as WC;
			return;
		}
		try {
			this.walletClient = (await getCurrentWalletClient()) as unknown as WC;
		} catch (error) {
			console.warn("getCurrentWalletClient failed", error);
			this.walletClient = undefined as unknown as WC;
		}
	}

	async setWalletToCorrectChain(chainId: number | bigint) {
		try {
			return await switchWalletChain(this.walletClient, Number(chainId));
		} catch (error) {
			console.warn(
				`Wallet does not support switchChain or failed to switch chain: ${Number(chainId)}`,
				error
			);
			return undefined;
		}
	}

	mapOverCoinsCached<T>(opts: {
		bucket: "balance" | "allowance" | "compact";
		ttlMs: number;
		isMainnet: boolean;
		scopeKey: string;
		fetcher: (
			asset: `0x${string}`,
			client: (typeof clientsById)[keyof typeof clientsById]
		) => Promise<T>;
	}) {
		const { bucket, ttlMs, isMainnet, scopeKey, fetcher } = opts;
		const resolved: Record<number, Record<`0x${string}`, Promise<T>>> = {};
		for (const token of coinList(isMainnet)) {
			if (!resolved[token.chainId]) resolved[token.chainId] = {};
			const key = `${bucket}:${isMainnet ? "mainnet" : "testnet"}:${token.chainId}:${token.address}:${scopeKey}`;
			resolved[token.chainId][token.address] = getOrFetchRpc(
				key,
				() => fetcher(token.address, clientsById[token.chainId]),
				{ ttlMs }
			);
		}
		return resolved;
	}

	dbReady: Promise<void> | undefined;

	constructor() {
		this.inputTokens = [{ token: coinList(this.mainnet)[0], amount: 1000000n }];
		this.outputTokens = [{ token: coinList(this.mainnet)[1], amount: 1000000n }];

		if (browser) {
			reconnectWallet()
				.catch((error) => console.warn("reconnectWallet failed", error))
				.finally(() => {
					this.walletConnection = getCurrentConnection();
					this.syncWalletClient().catch((error) => console.warn("syncWalletClient failed", error));
				});

			this._unwatchWalletConnection = watchWalletConnection((connection) => {
				this.walletConnection = connection;
				this.syncWalletClient().catch((error) => console.warn("syncWalletClient failed", error));
			});
		}

		this.startRpcRefreshLoop();

		this.dbReady = browser
			? Promise.all([
					this.loadOrdersFromDb().catch((e) => console.warn("loadOrdersFromDb error", e)),
					this.loadFillTransactionsFromDb().catch((e) =>
						console.warn("loadFillTransactionsFromDb error", e)
					),
					this.loadTransactionReceiptsFromDb().catch((e) =>
						console.warn("loadTransactionReceiptsFromDb error", e)
					)
				]).then(() => {})
			: Promise.resolve();
	}
}

export const store = new Store();
export default store;
