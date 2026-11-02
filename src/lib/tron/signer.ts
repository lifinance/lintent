import type { TronTxInfo, TronWebLike } from "./types";

// Plain runtime check instead of $app/environment so bun tests can import this module.
const browser = typeof window !== "undefined";

// --- Wallet connection (TronLink) --- //

export type TronWalletConnection = {
  status: "connected" | "disconnected";
  address?: string;
  hexAddress?: `0x${string}`;
};

export function isTronLinkAvailable(): boolean {
  if (!browser) return false;
  return !!(window.tronLink || window.tronWeb);
}

function injectedTronWeb(): TronWebLike | undefined {
  if (!browser) return undefined;
  return (window.tronWeb ?? window.tronLink?.tronWeb) as TronWebLike | undefined;
}

export function getTronConnection(): TronWalletConnection {
  const tw = injectedTronWeb();
  const base58 = tw?.defaultAddress?.base58;
  const hex = tw?.defaultAddress?.hex;
  if (!tw?.ready || typeof base58 !== "string" || typeof hex !== "string") {
    return { status: "disconnected" };
  }
  // TronLink reports the account as 21-byte hex with the 41 network prefix.
  return {
    status: "connected",
    address: base58,
    hexAddress: `0x${hex.replace(/^0x/, "").replace(/^41/, "")}` as `0x${string}`
  };
}

export async function connectTronLink(): Promise<TronWalletConnection> {
  if (!browser) return { status: "disconnected" };

  const tronLink = window.tronLink;
  if (!tronLink) {
    throw new Error("TronLink is not installed");
  }

  const existing = getTronConnection();
  if (existing.status === "connected") return existing;

  const result = await tronLink.request({ method: "tron_requestAccounts" });

  // TronLink may take a moment to populate tronWeb after approval — poll
  // briefly instead of a single fixed sleep (slow wallets caused spurious
  // "connection failed" errors).
  for (let waited = 0; waited < 5_000; waited += 250) {
    const conn = getTronConnection();
    if (conn.status === "connected") return conn;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (result?.code === 4001) {
    throw new Error("User rejected the connection request");
  }
  throw new Error(result?.message ?? "TronLink connection failed");
}

export function watchTronConnection(onChange: (conn: TronWalletConnection) => void): () => void {
  if (!browser) return () => {};

  let prev = getTronConnection();

  const emitIfChanged = () => {
    const next = getTronConnection();
    if (next.status !== prev.status || next.hexAddress !== prev.hexAddress) {
      prev = next;
      invalidateNetworkGuardCache();
      onChange(next);
    }
  };

  // TronLink communicates account changes via window messages…
  const onMessage = (e: MessageEvent) => {
    const action = e.data?.message?.action;
    if (action === "setAccount" || action === "setNode" || action === "disconnect") {
      if (action === "setNode") invalidateNetworkGuardCache();
      emitIfChanged();
    }
  };
  window.addEventListener("message", onMessage);

  // …but not all versions emit them reliably, so also poll.
  const interval = setInterval(emitIfChanged, 2000);

  return () => {
    window.removeEventListener("message", onMessage);
    clearInterval(interval);
  };
}

// --- Network guard --- //

export const TRON_MAINNET_GENESIS_BLOCK_ID =
  "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc";

// Short-lived guard cache keyed by the TronWeb instance: TronLink can switch
// node/network behind an unchanged object, so entries expire quickly and are
// invalidated on account/node-change events.
const GUARD_TTL_MS = 60_000;
const guardCache = new WeakMap<object, { genesis: string; expiresAt: number }>();
let guardEpoch = 0;
const guardEpochByInstance = new WeakMap<object, number>();

export function invalidateNetworkGuardCache(): void {
  guardEpoch += 1;
}

async function genesisOf(tw: TronWebLike): Promise<string> {
  const cached = guardCache.get(tw);
  if (cached && cached.expiresAt > Date.now() && guardEpochByInstance.get(tw) === guardEpoch) {
    return cached.genesis;
  }
  const block = await tw.trx.getBlockByNumber(0);
  const genesis = block?.blockID ?? "";
  guardCache.set(tw, { genesis, expiresAt: Date.now() + GUARD_TTL_MS });
  guardEpochByInstance.set(tw, guardEpoch);
  return genesis;
}

/**
 * Hard-blocks writes when the signer is not on Tron mainnet (Nile/Shasta/
 * custom nodes), verified by genesis block ID rather than host string. Also
 * rejects when the signer and read client disagree about the network.
 */
export async function assertTronMainnet(signer: TronWebLike, reads?: TronWebLike): Promise<void> {
  const signerGenesis = await genesisOf(signer);
  if (signerGenesis !== TRON_MAINNET_GENESIS_BLOCK_ID) {
    throw new Error(
      "TronLink is connected to a non-mainnet Tron network — switch it to Tron mainnet and retry"
    );
  }
  if (reads) {
    const readsGenesis = await genesisOf(reads);
    if (readsGenesis !== signerGenesis) {
      throw new Error("Tron signer and read client are on different networks");
    }
  }
}

// --- Transaction confirmation --- //

function decodeResMessage(resMessage?: string): string | undefined {
  if (!resMessage) return undefined;
  try {
    const bytes = resMessage.replace(/^0x/, "");
    let out = "";
    for (let i = 0; i < bytes.length; i += 2) {
      out += String.fromCharCode(parseInt(bytes.substring(i, i + 2), 16));
    }
    return out;
  } catch {
    return resMessage;
  }
}

export type TronWaitMode = "inclusion" | "confirmed";

/**
 * Polls until the transaction is mined (mode "inclusion", via the full node
 * when the client exposes it) or solidified (mode "confirmed" — tronweb's
 * `getTransactionInfo` queries the solidity node, which only returns data for
 * irreversible transactions). Throws on any failed execution: a mined
 * contract transaction is successful ONLY when `receipt.result === "SUCCESS"`
 * — Tron reports many failure values (REVERT, OUT_OF_ENERGY, OUT_OF_TIME,
 * ILLEGAL_OPERATION, …), so anything else is treated as failure. TronGrid
 * returns `{}` while the transaction is not yet known.
 */
export async function waitForTronTransaction(
  reads: TronWebLike,
  txId: string,
  opts: { mode?: TronWaitMode; timeoutMs?: number; intervalMs?: number } = {}
): Promise<TronTxInfo> {
  const { mode = "inclusion", timeoutMs = 120_000, intervalMs = 3_000 } = opts;
  const id = txId.replace(/^0x/, "");
  const deadline = Date.now() + timeoutMs;
  const fetchInfo =
    mode === "inclusion" && reads.trx.getUnconfirmedTransactionInfo
      ? () => reads.trx.getUnconfirmedTransactionInfo!(id)
      : () => reads.trx.getTransactionInfo(id);

  while (Date.now() < deadline) {
    const info = await fetchInfo().catch(() => undefined);
    const mined = info && typeof info.blockNumber === "number";
    if (mined) {
      const receiptResult = info.receipt?.result;
      const failed =
        info.result === "FAILED" || (receiptResult !== undefined && receiptResult !== "SUCCESS");
      if (failed) {
        const detail = decodeResMessage(info.resMessage);
        throw new Error(
          `Tron transaction ${id} failed (${receiptResult ?? info.result ?? "unknown"})${detail ? `: ${detail}` : ""}`
        );
      }
      // Success needs an explicit signal — every write this waiter guards is a
      // contract call, which always carries receipt.result. A mined response
      // without it is incomplete data, not success; keep polling.
      if (receiptResult === "SUCCESS") return info;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for Tron transaction ${id} (${mode}, ${timeoutMs}ms)`);
}
