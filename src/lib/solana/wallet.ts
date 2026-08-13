// Solana wallet connection, via @solana/wallet-adapter.
//
// Adapters are used rather than a hand-rolled `window.solana` binding (the
// Tron facade's approach) because Solana has several wallets with meaningfully
// different injection behaviour, and the adapters already encode that. The
// cost is a Buffer polyfill, installed in src/hooks.client.ts.

import { solanaBase58ToBytes32 } from "@lifi/intent";
import { assertSolanaCluster, getSolanaReads } from "./client";
import type { SolanaInstructionLike, SolanaSignerLike } from "./types";

// Plain runtime check instead of $app/environment so bun tests can import this
// module — same reason as src/lib/tron/signer.ts.
const browser = typeof window !== "undefined";

export type SolanaWalletConnection = {
  status: "connected" | "disconnected";
  /** Base58, for display and for building instructions. */
  address?: string;
  /** The same key as 32-byte hex — the app's canonical internal identity. */
  addressBytes32?: `0x${string}`;
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

let adapters: Adapter[] | undefined;
let active: Adapter | undefined;

async function loadAdapters(): Promise<Adapter[]> {
  if (adapters) return adapters;
  const [{ PhantomWalletAdapter }, { SolflareWalletAdapter }] = await Promise.all([
    import("@solana/wallet-adapter-phantom"),
    import("@solana/wallet-adapter-solflare")
  ]);
  adapters = [
    new PhantomWalletAdapter() as unknown as Adapter,
    new SolflareWalletAdapter() as unknown as Adapter
  ];
  return adapters;
}

/** The wallets we offer, with whatever the adapter knows about availability. */
export async function listSolanaWallets(): Promise<SolanaWalletOption[]> {
  if (!browser) return [];
  const all = await loadAdapters();
  return all.map((adapter) => ({
    name: adapter.name,
    readyState: String(adapter.readyState),
    icon: adapter.icon
  }));
}

function toConnection(adapter: Adapter | undefined): SolanaWalletConnection {
  const address = adapter?.connected ? adapter.publicKey?.toBase58() : undefined;
  if (!address) return { status: "disconnected" };
  return {
    status: "connected",
    address,
    addressBytes32: solanaBase58ToBytes32(address)
  };
}

export function getSolanaConnectionState(): SolanaWalletConnection {
  return toConnection(active);
}

export async function connectSolanaWallet(name: string): Promise<SolanaWalletConnection> {
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

  void loadAdapters().then((all) => {
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
  });

  return () => {
    disposed = true;
    for (const detach of detachers) detach();
  };
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

      const connection = new Connection(
        reads.rpcEndpoint ?? "https://api.mainnet-beta.solana.com",
        "confirmed"
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = new PublicKey(address);

      const signed = await adapter.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signed.serialize());

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new Error(
          `Solana transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      // Confirmation alone is not proof the instructions succeeded — read the
      // transaction back and check `meta.err`. Absent metadata means "not
      // indexed yet", which must never be reported as success.
      const tx = await reads.getTransaction(signature, { commitment: "confirmed" });
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
