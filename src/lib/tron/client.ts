import { browser } from "$app/environment";
import type { TronWebLike } from "./types";

// Neutral "black hole" address: TronWeb rejects constant `.call()`s from an
// unkeyed instance ("owner_address isn't set"), so the read client gets this
// as its default address. It never signs anything.
export const TRON_NEUTRAL_CALLER = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

const TRONGRID_HOST = "https://api.trongrid.io";

// Deliberately public rate-limit credential (PUBLIC_ prefix = shipped in the
// client bundle). Optional — TronGrid works unauthenticated at lower limits.
const tronGridApiKey: string | undefined =
  import.meta.env?.PUBLIC_TRONGRID_API_KEY?.trim() || undefined;

let readsPromise: Promise<TronWebLike> | undefined;

/**
 * Memoized TronGrid-backed read client. Lazily imports `tronweb` so the
 * package stays out of SSR and the main chunk (and out of bun's runtime,
 * which cannot load it — unit tests mock `TronWebLike` instead).
 */
export function getTronReads(): Promise<TronWebLike> {
  if (!browser) {
    return Promise.reject(new Error("Tron reads are only available in the browser"));
  }
  if (!readsPromise) {
    readsPromise = import("tronweb").then(({ TronWeb }) => {
      const tw = new TronWeb({
        fullHost: TRONGRID_HOST,
        ...(tronGridApiKey ? { headers: { "TRON-PRO-API-KEY": tronGridApiKey } } : {})
      }) as unknown as TronWebLike;
      tw.setAddress?.(TRON_NEUTRAL_CALLER);
      return tw;
    });
    readsPromise.catch(() => {
      readsPromise = undefined;
    });
  }
  return readsPromise;
}

/** The TronLink-injected TronWeb instance. Throws when TronLink is absent —
 * only the write path may call this; reads go through `getTronReads`. */
export function getTronSigner(): TronWebLike {
  const injected = browser
    ? ((window.tronWeb ?? window.tronLink?.tronWeb) as TronWebLike | undefined)
    : undefined;
  if (!injected) throw new Error("TronLink is not connected");
  return injected;
}
