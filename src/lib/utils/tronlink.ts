import { browser } from "$app/environment";

export type TronWalletConnection = {
  status: "connected" | "disconnected";
  address?: string;
  hexAddress?: `0x${string}`;
};

export function isTronLinkAvailable(): boolean {
  if (!browser) return false;
  return !!(window.tronLink || window.tronWeb);
}

export function getTronWeb(): TronWeb | undefined {
  if (!browser) return undefined;
  return window.tronWeb ?? window.tronLink?.tronWeb;
}

export function getTronConnection(): TronWalletConnection {
  const tw = getTronWeb();
  if (!tw?.ready || !tw.defaultAddress?.base58) {
    return { status: "disconnected" };
  }
  const hex = tw.defaultAddress.hex;
  return {
    status: "connected",
    address: tw.defaultAddress.base58,
    hexAddress: `0x${hex.replace(/^(41|0x)/, "")}` as `0x${string}`
  };
}

export async function connectTronLink(): Promise<TronWalletConnection> {
  if (!browser) return { status: "disconnected" };

  const tronLink = window.tronLink;
  if (!tronLink) {
    throw new Error("TronLink is not installed");
  }

  // Check if already connected before requesting
  const existing = getTronConnection();
  if (existing.status === "connected") return existing;

  const result = await tronLink.request({ method: "tron_requestAccounts" });

  // TronLink may take a moment to populate tronWeb after approval
  await new Promise((r) => setTimeout(r, 500));

  const conn = getTronConnection();
  if (conn.status === "connected") return conn;

  if (result.code === 4001) {
    throw new Error("User rejected the connection request");
  }
  throw new Error(result.message ?? "TronLink connection failed");
}

export function disconnectTronLink(): void {
  // TronLink doesn't have a programmatic disconnect — clear local state only
}

export function watchTronConnection(onChange: (conn: TronWalletConnection) => void): () => void {
  if (!browser) return () => {};

  let prev = getTronConnection();

  const onMessage = (e: MessageEvent) => {
    if (e.data?.message?.action === "setAccount" || e.data?.message?.action === "setNode") {
      const next = getTronConnection();
      if (next.status !== prev.status || next.hexAddress !== prev.hexAddress) {
        prev = next;
        onChange(next);
      }
    }
  };

  // TronLink communicates account changes via window messages
  window.addEventListener("message", onMessage);

  // Also poll for changes (some TronLink versions don't emit messages reliably)
  const interval = setInterval(() => {
    const next = getTronConnection();
    if (next.status !== prev.status || next.hexAddress !== prev.hexAddress) {
      prev = next;
      onChange(next);
    }
  }, 2000);

  return () => {
    window.removeEventListener("message", onMessage);
    clearInterval(interval);
  };
}
