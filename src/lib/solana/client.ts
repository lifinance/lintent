import { SOLANA_DEVNET_CHAIN_ID, SOLANA_MAINNET_CHAIN_ID } from "@lifi/intent";
import { isSolanaChain, isSolanaMainnet } from "$lib/utils/chainType";
import type { SolanaConnectionLike } from "./types";

// Plain runtime check instead of $app/environment so bun tests can import this
// module — same reason as src/lib/tron/signer.ts.
const browser = typeof window !== "undefined";

// Public endpoints rate-limit aggressively against the app's balance polling,
// so a dedicated RPC is strongly recommended. PUBLIC_ prefix = shipped in the
// client bundle, which is fine for an RPC URL.
const mainnetRpcUrl =
  import.meta.env?.PUBLIC_SOLANA_MAINNET_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const devnetRpcUrl =
  import.meta.env?.PUBLIC_SOLANA_DEVNET_RPC_URL?.trim() || "https://api.devnet.solana.com";

export function solanaRpcUrl(chainId: number | bigint): string {
  return isSolanaMainnet(chainId) ? mainnetRpcUrl : devnetRpcUrl;
}

/**
 * Genesis hashes, used as the network guard.
 *
 * Checking the genesis hash rather than the RPC URL is deliberate: a wallet
 * can be pointed at any endpoint, and only the genesis block identifies the
 * cluster it actually serves. Same reasoning as
 * TRON_MAINNET_GENESIS_BLOCK_ID in the Tron facade.
 *
 * UNVERIFIED against a live RPC — see tests/fixtures/solana/PREFLIGHT.md.
 * These are the widely published values; confirm before enabling mainnet.
 */
export const SOLANA_GENESIS_HASHES: Record<string, string> = {
  [SOLANA_MAINNET_CHAIN_ID.toString()]: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  [SOLANA_DEVNET_CHAIN_ID.toString()]: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
};

const connections = new Map<string, Promise<SolanaConnectionLike>>();

/**
 * Memoized read connection for a chain id.
 *
 * Keyed by chain id rather than a single global, because a Solana order's
 * cluster comes from the order itself: an app that keeps one connection and
 * flips it with a UI toggle will happily send a devnet order to mainnet.
 *
 * `@solana/web3.js` is imported lazily to keep it out of SSR and the main
 * chunk, mirroring `getTronReads`.
 */
export function getSolanaReads(chainId: number | bigint): Promise<SolanaConnectionLike> {
  if (!browser) {
    return Promise.reject(new Error("Solana reads are only available in the browser"));
  }
  if (!isSolanaChain(chainId)) {
    return Promise.reject(new Error(`Chain ${chainId} is not a Solana chain`));
  }

  const key = chainId.toString();
  const existing = connections.get(key);
  if (existing) return existing;

  const created = import("@solana/web3.js").then(({ Connection, PublicKey }) => {
    const connection = new Connection(solanaRpcUrl(chainId), "confirmed");

    // Adapt the SDK to SolanaConnectionLike so nothing downstream sees a
    // PublicKey. Address strings in, plain values out.
    const adapter: SolanaConnectionLike = {
      rpcEndpoint: connection.rpcEndpoint,
      getGenesisHash: () => connection.getGenesisHash(),
      getAccountInfo: async (address, commitment) => {
        const info = await connection.getAccountInfo(new PublicKey(address), commitment);
        if (!info) return null;
        return {
          owner: info.owner.toBase58(),
          lamports: info.lamports,
          data: new Uint8Array(info.data)
        };
      },
      getMultipleAccountsInfo: async (addresses) => {
        const infos = await connection.getMultipleAccountsInfo(
          addresses.map((address) => new PublicKey(address))
        );
        return infos.map((info) =>
          info
            ? {
                owner: info.owner.toBase58(),
                lamports: info.lamports,
                data: new Uint8Array(info.data)
              }
            : null
        );
      },
      getTransaction: async (signature, opts) => {
        const tx = await connection.getTransaction(signature, {
          commitment:
            opts?.commitment === "processed" ? "confirmed" : (opts?.commitment ?? "confirmed"),
          maxSupportedTransactionVersion: 0
        });
        if (!tx) return null;
        return {
          slot: tx.slot,
          blockTime: tx.blockTime,
          meta: tx.meta ? { err: tx.meta.err, logMessages: tx.meta.logMessages ?? null } : null
        };
      },
      getBalance: async (address) => BigInt(await connection.getBalance(new PublicKey(address))),
      getTokenAccountBalance: async (address) => {
        // An ATA that has never been funded does not exist, and that is a zero
        // balance rather than an error. Everything else — rate limits, network
        // failures — must propagate: reporting those as 0n tells the user they
        // hold nothing, which is worse than showing an error.
        const info = await connection.getAccountInfo(new PublicKey(address));
        if (!info) return 0n;
        const balance = await connection.getTokenAccountBalance(new PublicKey(address));
        return BigInt(balance.value.amount);
      },
      getLatestBlockhash: () => connection.getLatestBlockhash()
    };
    return adapter;
  });

  // Do not cache a rejected connection: a transient import or network failure
  // would otherwise poison every later call.
  created.catch(() => connections.delete(key));
  connections.set(key, created);
  return created;
}

const guardedEndpoints = new Set<string>();

/** Clears the memoized cluster guard. Test-only seam. */
export function invalidateSolanaClusterGuard(): void {
  guardedEndpoints.clear();
}

/**
 * Asserts the connection really serves the cluster `chainId` names.
 *
 * Called before every write. Cached per endpoint+chain because the genesis
 * hash cannot change for a live endpoint, and an extra round trip before each
 * signature is a poor trade.
 */
export async function assertSolanaCluster(
  chainId: number | bigint,
  reads: SolanaConnectionLike
): Promise<void> {
  const expected = SOLANA_GENESIS_HASHES[chainId.toString()];
  if (!expected) {
    throw new Error(`No genesis hash configured for Solana chain ${chainId}`);
  }

  const cacheKey = `${reads.rpcEndpoint ?? "unknown"}:${chainId}`;
  if (guardedEndpoints.has(cacheKey)) return;

  const actual = await reads.getGenesisHash();
  if (actual !== expected) {
    throw new Error(
      `Solana RPC ${reads.rpcEndpoint ?? ""} serves genesis ${actual}, expected ${expected} for chain ${chainId}. Refusing to sign against the wrong cluster.`
    );
  }
  guardedEndpoints.add(cacheKey);
}
