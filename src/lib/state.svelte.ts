import type { OrderContainer } from "@lifi/intent";
import { ADDRESS_ZERO } from "@lifi/intent";
import type { GetTransactionReceiptReturnType } from "viem";
import type { AppTokenContext, OrderContainerWithMeta } from "./appTypes";
import {
  ALWAYS_OK_ALLOCATOR,
  clientsById,
  coinList,
  COMPACT,
  INPUT_SETTLER_COMPACT_LIFI,
  INPUT_SETTLER_ESCROW_LIFI,
  MULTICHAIN_INPUT_SETTLER_COMPACT,
  MULTICHAIN_INPUT_SETTLER_ESCROW,
  TRON_MAINNET_INPUT_SETTLER,
  isChainIdTestnet,
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
  transactionReceipts as transactionReceiptsTable,
  hyperlaneSubmissions as hyperlaneSubmissionsTable,
  tokens as tokensTable
} from "./schema";
import { hyperlaneSubmissionKey, type HyperlaneSubmission } from "./libraries/hyperlaneSubmission";
import { and, eq, ne, notInArray } from "drizzle-orm";
import { containerToIntent } from "./utils/intent";
import { getOrFetchRpc, invalidateRpcPrefix } from "./libraries/rpcCache";
import {
  getCurrentConnection,
  getCurrentWalletClient,
  reconnectWallet,
  type WalletConnection,
  watchWalletConnection
} from "./utils/wagmi";
import { switchWalletChain } from "./utils/walletClientRuntime";
import {
  type TronWalletConnection,
  getTronConnection,
  watchTronConnection
} from "$lib/tron/signer";
import { getTronReads } from "$lib/tron/client";
import { getTrc20Allowance, getTrc20Balance, getTrxBalance } from "$lib/tron/reads";
import { maxUint256 } from "viem";
import { isTronChain } from "./utils/chainType";

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

class Store {
  mainnet = $state<boolean>(true);
  useProductionApi = $state<boolean | null>(null);
  orders = $state<OrderContainer[]>([]);

  async loadOrdersFromDb() {
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;
    const rows = await db!.select().from(intents);
    this.orders = rows.map((r) => {
      const order = JSON.parse(r.data) as OrderContainerWithMeta;
      // Re-attach the authoritative column values dropped by JSON.parse. The
      // dedicated `created_at` column always wins over anything stale in the
      // blob; `submitTime` (order-server time) round-trips inside the blob.
      order.id = r.id;
      order.intentType = r.intentType;
      order.createdAt = r.createdAt;
      return order;
    });
  }

  async saveOrderToDb(order: OrderContainerWithMeta) {
    if (!browser) return;
    if (!db) await initDb();
    const orderId = containerToIntent(order).orderId();
    const now = Math.floor(Date.now() / 1000);
    // Stamp the local "added to list" time onto the in-memory object so freshly
    // created/imported intents sort correctly immediately (the column is only
    // read back on reload). Guard so re-saves don't overwrite the original.
    if (order.createdAt === undefined) order.createdAt = now;
    const id = order.id ?? generateUUID();
    const intentType = order.intentType ?? "escrow";
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
    const idx = this.orders.findIndex((o) => containerToIntent(o).orderId() === orderId);
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
        id: generateUUID(),
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

  async loadHyperlaneSubmissionsFromDb() {
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;
    const rows = await db!.select().from(hyperlaneSubmissionsTable);
    const loaded: Record<string, HyperlaneSubmission> = {};
    for (const row of rows) {
      loaded[row.id] = {
        key: row.id,
        orderId: row.orderId as `0x${string}`,
        inputChainId: row.inputChainId,
        outputChainId: row.outputChainId,
        outputHash: row.outputHash,
        payloadHash: row.payloadHash as `0x${string}`,
        submitTxHash: row.submitTxHash as `0x${string}`,
        messageId: (row.messageId as `0x${string}` | null) ?? undefined,
        submittedAt: row.submittedAt
      };
    }
    this.hyperlaneSubmissions = loaded;
  }

  /**
   * Records (or updates) a dispatched Hyperlane submit. Written BEFORE the submit
   * receipt is awaited so a reload mid-wait cannot lose the fact that interchain gas was
   * already paid, and updated again once the message id is known.
   */
  async saveHyperlaneSubmission(submission: HyperlaneSubmission) {
    // Update the in-memory record first: the whole point is that a reload — or a second
    // prove click — must never dispatch twice, and the DB write may lag or fail.
    this.hyperlaneSubmissions[submission.key] = submission;
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;
    const values = {
      id: submission.key,
      orderId: submission.orderId,
      inputChainId: submission.inputChainId,
      outputChainId: submission.outputChainId,
      outputHash: submission.outputHash,
      payloadHash: submission.payloadHash,
      submitTxHash: submission.submitTxHash,
      messageId: submission.messageId ?? null,
      submittedAt: submission.submittedAt
    };
    try {
      const existing = await db!
        .select()
        .from(hyperlaneSubmissionsTable)
        .where(eq(hyperlaneSubmissionsTable.id, submission.key));
      if (existing.length > 0) {
        await db!
          .update(hyperlaneSubmissionsTable)
          .set(values)
          .where(eq(hyperlaneSubmissionsTable.id, submission.key));
      } else {
        await db!.insert(hyperlaneSubmissionsTable).values(values);
      }
    } catch (error) {
      console.warn("saveHyperlaneSubmission db write failed", { key: submission.key, error });
    }
  }

  /** Drops a record whose dispatch turned out not to have happened (reverted submit). */
  async deleteHyperlaneSubmission(key: string) {
    delete this.hyperlaneSubmissions[key];
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;
    try {
      await db!.delete(hyperlaneSubmissionsTable).where(eq(hyperlaneSubmissionsTable.id, key));
    } catch (error) {
      console.warn("deleteHyperlaneSubmission db delete failed", { key, error });
    }
  }

  getHyperlaneSubmission(
    orderId: `0x${string}`,
    inputChainId: number | bigint,
    outputHash: string
  ): HyperlaneSubmission | undefined {
    return this.hyperlaneSubmissions[hyperlaneSubmissionKey(orderId, inputChainId, outputHash)];
  }

  getTransactionReceipt(chainId: number | bigint, txHash: `0x${string}`) {
    const serialized = this.transactionReceipts[`${Number(chainId)}:${txHash}`];
    if (!serialized) return undefined;
    try {
      return JSON.parse(serialized) as GetTransactionReceiptReturnType;
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

  tronWalletConnection = $state<TronWalletConnection>({ status: "disconnected" });
  tronConnectedAccount = $derived(
    this.tronWalletConnection.status === "connected" && this.tronWalletConnection.hexAddress
      ? {
          address: this.tronWalletConnection.hexAddress,
          base58Address: this.tronWalletConnection.address!
        }
      : undefined
  );
  _unwatchTronConnection?: () => void;

  anyWalletConnected = $derived(
    (!!this.connectedAccount && !!this.walletClient) || !!this.tronConnectedAccount
  );

  accountForChain(chainId: number | bigint): `0x${string}` | undefined {
    if (isTronChain(chainId)) return this.tronConnectedAccount?.address;
    return this.connectedAccount?.address;
  }

  availableTokens = $state<Token[]>([...(coinList(true) as readonly Token[])]);
  manualTokenKeys = $state<Set<string>>(new Set());
  inputTokens = $state<AppTokenContext[]>([]);
  outputTokens = $state<AppTokenContext[]>([]);
  fillTransactions = $state<{ [outputId: string]: `0x${string}` }>({});
  transactionReceipts = $state<Record<string, string>>({});
  /** Keyed by `hyperlaneSubmissionKey`. Reload-safe: mirrored in `hyperlane_submissions`. */
  hyperlaneSubmissions = $state<Record<string, HyperlaneSubmission>>({});

  refreshEpoch = $state(0);
  rpcRefreshMs = 45_000;
  _rpcRefreshHandle?: ReturnType<typeof setInterval>;

  balances = $derived.by(() => {
    this.refreshEpoch;
    const evmAccount = this.connectedAccount?.address;
    const tronAccount = this.tronConnectedAccount?.address;
    return this.mapOverCoinsCached({
      bucket: "balance",
      ttlMs: 30_000,
      tronTtlMs: 120_000,
      isMainnet: this.mainnet,
      scopeKey: `${evmAccount ?? "none"}:${tronAccount ?? "none"}`,
      fetcher: async (asset, client, chainId) => {
        const account = isTronChain(chainId) ? tronAccount : evmAccount;
        if (!account) return 0n;
        if (isTronChain(chainId)) {
          // TronGrid-backed reads — viewing balances must not require TronLink.
          const reads = await getTronReads();
          return asset.toLowerCase() === ADDRESS_ZERO
            ? getTrxBalance(reads, account)
            : getTrc20Balance(reads, asset, account);
        }
        return getBalance(account, asset, client);
      }
    });
  });

  allowances = $derived.by(() => {
    this.refreshEpoch;
    const evmAccount = this.connectedAccount?.address;
    const tronAccount = this.tronConnectedAccount?.address;
    const spender =
      this.inputSettler === INPUT_SETTLER_COMPACT_LIFI ||
      this.inputSettler === MULTICHAIN_INPUT_SETTLER_COMPACT
        ? COMPACT
        : this.inputSettler;
    return this.mapOverCoinsCached({
      bucket: "allowance",
      ttlMs: 60_000,
      tronTtlMs: 180_000,
      isMainnet: this.mainnet,
      scopeKey: `${evmAccount ?? "none"}:${tronAccount ?? "none"}:${spender}`,
      fetcher: async (asset, client, chainId) => {
        const account = isTronChain(chainId) ? tronAccount : evmAccount;
        if (!account) return 0n;
        if (isTronChain(chainId)) {
          // Native TRX needs no allowance; TRC-20 allowances via TronGrid.
          if (asset.toLowerCase() === ADDRESS_ZERO) return maxUint256;
          const reads = await getTronReads();
          return getTrc20Allowance(reads, asset, account, TRON_MAINNET_INPUT_SETTLER);
        }
        return getAllowance(spender)(account, asset, client);
      }
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
      fetcher: (asset, client, chainId) => {
        if (isTronChain(chainId)) return Promise.resolve(0n);
        return getCompactBalance(account, asset, client, allocatorId);
      }
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
  exclusiveFor: string = $state("");
  recipient: string = $state("");
  useExclusiveForQuoteRequest = $state(false);
  // 1:1 stablecoin demo: when on, quote requests send the X-Integrator-Key header
  // and never set metadata.exclusiveFor (the integrator key drives the quote), but
  // the on-chain intent is still made exclusive to the demo solver so it fills 1:1.
  use11Demo = $state(false);
  integratorKey: string = $state("");

  invalidateWalletReadCache(scope: "all" | "balance" | "allowance" | "compact" = "all") {
    if (scope === "all" || scope === "balance") invalidateRpcPrefix("balance:");
    if (scope === "all" || scope === "allowance") invalidateRpcPrefix("allowance:");
    if (scope === "all" || scope === "compact") invalidateRpcPrefix("compact:");
    if (scope === "all") {
      // Flow-progress state changes on-chain after fill/prove/claim actions —
      // stale cached "false" here keeps the step tracker behind for a full TTL.
      invalidateRpcPrefix("progress:");
      invalidateRpcPrefix("claim:");
    }
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

  private async loadTokensFromDb(mainnet: boolean) {
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;
    const rows = await db!.select().from(tokensTable).where(eq(tokensTable.isTestnet, !mainnet));
    this.availableTokens = rows.map((r) => ({
      address: r.address as `0x${string}`,
      name: r.name,
      chainId: r.chainId,
      decimals: r.decimals
    }));
    this.manualTokenKeys = new Set(
      rows.filter((r) => r.isManual).map((r) => `${r.chainId}:${r.address.toLowerCase()}`)
    );
  }

  async syncConfiguredTokens() {
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;

    const mainnetTokens = [...(coinList(true) as readonly Token[])];
    const testnetTokens = [...(coinList(false) as readonly Token[])];
    const allConfigured = [
      ...mainnetTokens.map((t) => ({ ...t, isTestnet: false })),
      ...testnetTokens.map((t) => ({ ...t, isTestnet: true }))
    ];

    // Upsert all configured tokens
    for (const t of allConfigured) {
      const id = `${t.chainId}:${t.address.toLowerCase()}`;
      try {
        await db!
          .insert(tokensTable)
          .values({
            id,
            address: t.address,
            name: t.name,
            chainId: t.chainId,
            decimals: t.decimals,
            isManual: false,
            isTestnet: t.isTestnet
          })
          .onConflictDoUpdate({
            target: tokensTable.id,
            set: { name: t.name, decimals: t.decimals, isTestnet: t.isTestnet, isManual: false }
          });
      } catch (_e) {
        // ignore individual upsert errors
      }
    }

    // Delete stale non-manual tokens not in current configured lists
    const configuredIds = allConfigured.map((t) => `${t.chainId}:${t.address.toLowerCase()}`);
    try {
      await db!
        .delete(tokensTable)
        .where(and(eq(tokensTable.isManual, false), notInArray(tokensTable.id, configuredIds)));
    } catch (_e) {
      // ignore
    }

    await this.loadTokensFromDb(this.mainnet);
  }

  async addCustomToken(token: Token) {
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;
    const isTestnet = isChainIdTestnet(token.chainId);
    const id = `${token.chainId}:${token.address.toLowerCase()}`;
    try {
      await db!
        .insert(tokensTable)
        .values({
          id,
          address: token.address,
          name: token.name,
          chainId: token.chainId,
          decimals: token.decimals,
          isManual: true,
          isTestnet
        })
        .onConflictDoUpdate({
          target: tokensTable.id,
          set: { name: token.name, decimals: token.decimals, isManual: true }
        });
    } catch (_e) {
      // fallback update
      await db!
        .update(tokensTable)
        .set({ name: token.name, decimals: token.decimals, isManual: true })
        .where(eq(tokensTable.id, id));
    }
    await this.loadTokensFromDb(this.mainnet);
  }

  async removeCustomToken(address: string, chainId: number) {
    if (!browser) return;
    if (!db) await initDb();
    if (!db) return;
    await db!
      .delete(tokensTable)
      .where(
        and(
          eq(tokensTable.address, address),
          eq(tokensTable.chainId, chainId),
          eq(tokensTable.isManual, true)
        )
      );
    await this.loadTokensFromDb(this.mainnet);
  }

  async syncTokensForNetwork(mainnet: boolean) {
    await this.loadTokensFromDb(mainnet);
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
    if (isTronChain(chainId)) return;
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
    tronTtlMs?: number;
    isMainnet: boolean;
    scopeKey: string;
    fetcher: (
      asset: `0x${string}`,
      client: (typeof clientsById)[keyof typeof clientsById],
      chainId: number
    ) => Promise<T>;
  }) {
    const { bucket, ttlMs, tronTtlMs, isMainnet, scopeKey, fetcher } = opts;
    const resolved: Record<number, Record<`0x${string}`, Promise<T>>> = {};
    for (const token of this.availableTokens) {
      if (!resolved[token.chainId]) resolved[token.chainId] = {};
      const key = `${bucket}:${isMainnet ? "mainnet" : "testnet"}:${token.chainId}:${token.address}:${scopeKey}`;
      const effectiveTtl = tronTtlMs && isTronChain(token.chainId) ? tronTtlMs : ttlMs;
      resolved[token.chainId][token.address] = getOrFetchRpc(
        key,
        () => fetcher(token.address, clientsById[token.chainId], token.chainId),
        { ttlMs: effectiveTtl }
      );
    }
    return resolved;
  }

  dbReady: Promise<void> | undefined;

  constructor() {
    this.availableTokens = [...(coinList(this.mainnet) as readonly Token[])];
    this.inputTokens = [{ token: this.availableTokens[0], amount: 1000000n }];
    this.outputTokens = [{ token: this.availableTokens[1], amount: 1000000n }];

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

      this.tronWalletConnection = getTronConnection();
      this._unwatchTronConnection = watchTronConnection((connection) => {
        this.tronWalletConnection = connection;
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
          ),
          this.loadHyperlaneSubmissionsFromDb().catch((e) =>
            console.warn("loadHyperlaneSubmissionsFromDb error", e)
          ),
          this.syncConfiguredTokens().catch((e) => console.warn("syncConfiguredTokens error", e))
        ]).then(() => {})
      : Promise.resolve();
  }
}

export const store = new Store();
export default store;
