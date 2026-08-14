// Solana wallet connection, via @solana/wallet-adapter.
//
// Adapters are used rather than a hand-rolled `window.solana` binding (the
// Tron facade's approach) because Solana has several wallets with meaningfully
// different injection behaviour, and the adapters already encode that. The
// cost is a Buffer polyfill, installed in src/hooks.client.ts.

import { solanaBase58ToBytes32 } from "@lifi/intent";
import { assertSolanaCluster, getSolanaReads, solanaRpcUrl } from "./client";
import type { SolanaConnectionLike, SolanaInstructionLike, SolanaSignerLike } from "./types";

// Plain runtime check instead of $app/environment so bun tests can import this
// module — same reason as src/lib/tron/signer.ts.
const browser = typeof window !== "undefined";

export type SolanaWalletConnection = {
  status: "connected" | "disconnected";
  /** Base58, for display and for building instructions. */
  address?: string;
  /** The same key as 32-byte hex — the app's canonical internal identity. */
  addressBytes32?: `0x${string}`;
  /** Which adapter is connected, so the UI can label the right wallet. */
  walletName?: string;
};

export type SolanaWalletOption = {
  name: string;
  /** "Installed" | "Loadable" | "NotDetected" | "Unsupported" */
  readyState: string;
  icon?: string;
};

type Adapter = {
  name: string;
  icon?: string;
  readyState: string;
  publicKey: { toBase58(): string } | null;
  connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signTransaction<T>(tx: T): Promise<T>;
  on(event: string, handler: () => void): void;
  off(event: string, handler: () => void): void;
};

let adapters: Promise<Adapter[]> | undefined;
let active: Adapter | undefined;

/**
 * The adapter singletons.
 *
 * The *promise* is memoised, not the resolved array: several callers subscribe
 * during startup (the store's connection watcher plus every component showing
 * a connect affordance), and caching only the settled value lets concurrent
 * callers each construct their own adapter set. The last one would win,
 * stranding earlier subscribers on orphaned adapters that never fire again.
 */
function loadAdapters(): Promise<Adapter[]> {
  if (adapters) return adapters;
  const created = Promise.all([
    import("@solana/wallet-adapter-phantom"),
    import("@solana/wallet-adapter-solflare")
  ]).then(([{ PhantomWalletAdapter }, { SolflareWalletAdapter }]) => [
    new PhantomWalletAdapter() as unknown as Adapter,
    new SolflareWalletAdapter() as unknown as Adapter
  ]);
  // A failed dynamic import must not be cached forever, or one flaky network
  // moment disables Solana for the whole session.
  created.catch(() => {
    if (adapters === created) adapters = undefined;
  });
  adapters = created;
  return created;
}

function describeWallet(adapter: Adapter): SolanaWalletOption {
  return {
    name: adapter.name,
    readyState: String(adapter.readyState),
    icon: adapter.icon
  };
}

/** The wallets we offer, with whatever the adapter knows about availability. */
export async function listSolanaWallets(): Promise<SolanaWalletOption[]> {
  if (!browser) return [];
  const all = await loadAdapters();
  return all.map(describeWallet);
}

/**
 * Whether a wallet can actually be connected right now.
 *
 * Solflare reports "Loadable" rather than "Installed" because it has a web
 * fallback that works without the extension, so only NotDetected/Unsupported
 * are genuinely unusable.
 */
export function isSolanaWalletDetected(wallet: SolanaWalletOption): boolean {
  return wallet.readyState !== "NotDetected" && wallet.readyState !== "Unsupported";
}

/**
 * Subscribes to wallet *availability* (as opposed to connection state).
 *
 * `readyState` is not static: an adapter reports NotDetected until its
 * extension injects, which routinely lands after first paint. A list captured
 * once at mount therefore leaves an installed wallet permanently greyed out,
 * so anything rendering a connect affordance must subscribe rather than read
 * `listSolanaWallets()` a single time.
 */
export function watchSolanaWallets(onChange: (wallets: SolanaWalletOption[]) => void): () => void {
  if (!browser) return () => undefined;

  let disposed = false;
  const detachers: (() => void)[] = [];

  void loadAdapters()
    .then((all) => {
      if (disposed) return;
      const emit = () => onChange(all.map(describeWallet));
      for (const adapter of all) {
        adapter.on("readyStateChange", emit);
        detachers.push(() => adapter.off("readyStateChange", emit));
      }
      emit();
    })
    .catch((error) => console.warn("Could not load Solana wallet adapters", error));

  return () => {
    disposed = true;
    for (const detach of detachers) detach();
  };
}

function toConnection(adapter: Adapter | undefined): SolanaWalletConnection {
  const address = adapter?.connected ? adapter.publicKey?.toBase58() : undefined;
  if (!address || !adapter) return { status: "disconnected" };
  return {
    status: "connected",
    address,
    addressBytes32: solanaBase58ToBytes32(address),
    walletName: adapter.name
  };
}

export function getSolanaConnectionState(): SolanaWalletConnection {
  return toConnection(active);
}

async function doConnect(name: string): Promise<SolanaWalletConnection> {
  const all = await loadAdapters();
  const adapter = all.find((candidate) => candidate.name === name);
  if (!adapter) throw new Error(`Unknown Solana wallet: ${name}`);

  // Disconnect the previous wallet first, otherwise two adapters both believe
  // they are connected and `getSolanaConnectionState` depends on call order.
  if (active && active !== adapter && active.connected) {
    await active.disconnect().catch(() => undefined);
  }

  await adapter.connect();
  active = adapter;
  return toConnection(adapter);
}

let connectQueue: Promise<unknown> = Promise.resolve();

/**
 * Connects `name`, serialised against any other in-flight connect.
 *
 * The queue is module-level because more than one component renders a connect
 * affordance (the status bar and the full-screen picker are mounted together),
 * and each tracks its own "connecting" flag. Without this, two overlapping
 * attempts can both pass the `active` check above, connect different adapters,
 * and leave `active` and the store disagreeing about which wallet is live.
 */
export function connectSolanaWallet(name: string): Promise<SolanaWalletConnection> {
  // Settle either way before starting the next: a rejected attempt must not
  // block the queue.
  const next = connectQueue.then(
    () => doConnect(name),
    () => doConnect(name)
  );
  connectQueue = next.catch(() => undefined);
  return next;
}

export async function disconnectSolanaWallet(): Promise<SolanaWalletConnection> {
  if (active?.connected) await active.disconnect().catch(() => undefined);
  active = undefined;
  return { status: "disconnected" };
}

/**
 * Subscribes to wallet connect/disconnect/account changes.
 *
 * The adapters emit real events, so unlike the Tron watcher this needs no
 * polling fallback. Handlers are attached to every adapter, not just the
 * active one, so connecting a second wallet still reports through.
 */
export function watchSolanaConnection(
  onChange: (connection: SolanaWalletConnection) => void
): () => void {
  if (!browser) return () => undefined;

  let disposed = false;
  const detachers: (() => void)[] = [];

  void loadAdapters()
    .then((all) => {
      if (disposed) return;
      for (const adapter of all) {
        const handler = () => {
          if (adapter.connected) active = adapter;
          else if (active === adapter) active = undefined;
          onChange(toConnection(active));
        };
        for (const event of ["connect", "disconnect", "error"]) {
          adapter.on(event, handler);
          detachers.push(() => adapter.off(event, handler));
        }
      }
    })
    .catch((error) => console.warn("Could not load Solana wallet adapters", error));

  return () => {
    disposed = true;
    for (const detach of detachers) detach();
  };
}

/**
 * Program logs from a failed `sendRawTransaction`.
 *
 * `SendTransactionError` exposes them two ways and neither is guaranteed: the
 * RPC sometimes returns them inline (`logs`), and otherwise they have to be
 * fetched with `getLogs(connection)`. Both are tried, and a failure to read
 * them is swallowed — this runs on an error path and must not replace the
 * original error with one about log fetching.
 */
async function simulationLogs(error: unknown, connection: unknown): Promise<string[]> {
  if (!error || typeof error !== "object") return [];
  const candidate = error as {
    logs?: unknown;
    getLogs?: (connection: unknown) => Promise<unknown>;
  };
  if (Array.isArray(candidate.logs) && candidate.logs.length) return candidate.logs.map(String);
  if (typeof candidate.getLogs !== "function") return [];
  try {
    const logs = await candidate.getLogs(connection);
    return Array.isArray(logs) ? logs.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Whether `error` is web3.js signalling that the blockhash expired before a
 * confirmation arrived.
 *
 * Matched by name rather than `instanceof`: the class is only reachable
 * through the lazily-imported module, and an `instanceof` against a second
 * copy of it would silently never match.
 */
function isBlockheightExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const named = error as { name?: unknown; message?: unknown };
  return (
    named.name === "TransactionExpiredBlockheightExceededError" ||
    (typeof named.message === "string" && named.message.includes("block height exceeded"))
  );
}

/**
 * Reads a transaction back, tolerating indexing lag.
 *
 * A transaction is queryable only once the RPC has indexed it, which trails
 * confirmation by a second or two — and by longer on a public endpoint under
 * load. A single immediate read therefore reports a perfectly good
 * transaction as unreadable, so this polls before giving up.
 */
async function readBackTransaction(reads: SolanaConnectionLike, signature: string) {
  let lastError: unknown;
  for (const waitMs of [0, 1000, 2000, 3000, 5000]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      const tx = await reads.getTransaction(signature, { commitment: "confirmed" });
      if (tx?.meta) return tx;
    } catch (error) {
      // A read failure here is transport noise, not a verdict on the
      // transaction — keep polling and let the caller decide after the budget
      // is spent.
      lastError = error;
    }
  }
  if (lastError) console.warn(`Could not read back Solana transaction ${signature}`, lastError);
  return null;
}

/**
 * A signer bound to `chainId`.
 *
 * The chain id is required, not inferred from any UI state: the cluster
 * belongs to the order being signed, and `assertSolanaCluster` runs before
 * every send so a wallet pointed at the wrong network fails loudly instead of
 * broadcasting somewhere unintended.
 */
export async function getSolanaSigner(chainId: number | bigint): Promise<SolanaSignerLike> {
  const adapter = active;
  const address = adapter?.connected ? adapter.publicKey?.toBase58() : undefined;
  if (!adapter || !address) {
    throw new Error("No Solana wallet is connected");
  }

  const reads = await getSolanaReads(chainId);

  return {
    publicKey: address,
    async signAndSend(instructions: SolanaInstructionLike[], opts) {
      await assertSolanaCluster(chainId, reads);

      const { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } =
        await import("@solana/web3.js");

      const transaction = new Transaction();
      if (opts?.computeUnitLimit) {
        // The default 200k CU is not enough for the proof-verification path;
        // without this the transaction fails late, after the signature.
        transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit }));
      }
      for (const ix of instructions) {
        transaction.add(
          new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys: ix.keys.map((key) => ({
              pubkey: new PublicKey(key.pubkey),
              isSigner: key.isSigner,
              isWritable: key.isWritable
            })),
            data: Buffer.from(ix.data)
          })
        );
      }

      // solanaRpcUrl, not a literal: api.mainnet-beta.solana.com 403s
      // application traffic, so hardcoding it as a fallback would send writes
      // to an endpoint that cannot answer them.
      const connection = new Connection(reads.rpcEndpoint ?? solanaRpcUrl(chainId), "confirmed");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = new PublicKey(address);

      const signed = await adapter.signTransaction(transaction);
      // A preflight failure carries the program logs, but only on the error
      // object — the message alone reduces an Anchor failure to a bare
      // `custom program error: 0x…`, which names neither the account nor the
      // constraint that rejected it. Surface the logs or the send is
      // undiagnosable from the browser console.
      const signature = await connection
        .sendRawTransaction(signed.serialize())
        .catch(async (error: unknown) => {
          const logs = await simulationLogs(error, connection);
          if (!logs.length) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message}\n\nProgram logs:\n${logs.join("\n")}`, { cause: error });
        });

      try {
        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed"
        );
        if (confirmation.value.err) {
          throw new Error(
            `Solana transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`
          );
        }
      } catch (error) {
        // `TransactionExpiredBlockheightExceededError` means the blockhash
        // stopped being valid before this client saw a confirmation — NOT that
        // the transaction failed. It routinely fires on a transaction that
        // landed, when the signature subscription drops or the fill lands near
        // the boundary. The read-back below is the authoritative answer, so
        // expiry falls through to it instead of surfacing as a failure on a
        // transaction the user can see succeeded.
        if (!isBlockheightExceeded(error)) throw error;
      }

      // Confirmation alone is not proof the instructions succeeded — read the
      // transaction back and check `meta.err`. Absent metadata means "not
      // indexed yet", which must never be reported as success; it is also the
      // normal state for a few seconds after landing, hence the retries.
      const tx = await readBackTransaction(reads, signature);
      if (!tx?.meta) {
        throw new Error(
          `Solana transaction ${signature} landed but its result could not be read back; treat it as unconfirmed`
        );
      }
      if (tx.meta.err) {
        const logs = (tx.meta.logMessages ?? []).slice(-5).join("\n");
        throw new Error(
          `Solana transaction ${signature} reverted: ${JSON.stringify(tx.meta.err)}\n${logs}`
        );
      }

      return signature;
    }
  };
}
