import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { STELLAR_NETWORK_PASSPHRASE } from "$lib/config";

// Stellar Wallets Kit touches `window`/custom elements on import, so it is only
// ever loaded through dynamic imports from browser code paths.
let kitReady: Promise<typeof StellarWalletsKit>;

export function ensureStellarKit() {
  kitReady ??= (async () => {
    const [{ StellarWalletsKit }, { defaultModules }, { Networks }] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit/sdk"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
      import("@creit.tech/stellar-wallets-kit/types")
    ]);
    StellarWalletsKit.init({ modules: defaultModules(), network: Networks.PUBLIC });
    return StellarWalletsKit;
  })();
  return kitReady;
}

/** Opens the wallet picker and returns the connected account (`G…`). */
export async function connectStellarWallet(): Promise<string> {
  const kit = await ensureStellarKit();
  const { address } = await kit.authModal();
  return address;
}

/** Returns the account remembered by the kit, or undefined if none is connected. */
export async function restoreStellarWallet(): Promise<string | undefined> {
  const kit = await ensureStellarKit();
  try {
    const { address } = await kit.getAddress();
    return address || undefined;
  } catch {
    return undefined;
  }
}

export async function disconnectStellarWallet() {
  const kit = await ensureStellarKit();
  await kit.disconnect();
}

/** Signs a transaction envelope (base64 XDR) on Stellar mainnet. */
export async function signStellarTransaction(xdr: string, address: string): Promise<string> {
  const kit = await ensureStellarKit();
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
    address
  });
  return signedTxXdr;
}
