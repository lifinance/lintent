import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction
} from "@stellar/freighter-api";
import { STELLAR_NETWORK_PASSPHRASE } from "$lib/config";

// Freighter has no programmatic disconnect; this flag decides whether a reload
// restores the account.
const CONNECTED_KEY = "lintent:stellar-connected";
const FREIGHTER_URL = "https://www.freighter.app/";

/** Requests access from Freighter and returns the connected account (`G…`). */
export async function connectStellarWallet(): Promise<string> {
  const { isConnected: installed } = await isConnected();
  if (!installed) {
    window.open(FREIGHTER_URL, "_blank");
    throw new Error("Freighter extension not found");
  }

  const { address, error } = await requestAccess();
  if (error) throw new Error(`Freighter: ${error.message}`);

  const network = await getNetworkDetails();
  if (network.error) throw new Error(`Freighter: ${network.error.message}`);
  if (network.networkPassphrase !== STELLAR_NETWORK_PASSPHRASE) {
    throw new Error("Switch Freighter to Mainnet");
  }

  localStorage.setItem(CONNECTED_KEY, "1");
  return address;
}

/** Returns the previously connected account, or undefined if none is available. */
export async function restoreStellarWallet(): Promise<string | undefined> {
  if (localStorage.getItem(CONNECTED_KEY) !== "1") return undefined;
  // Empty when the site is not allowed or Freighter is locked.
  const { address, error } = await getAddress();
  if (error || !address) return undefined;
  return address;
}

export async function disconnectStellarWallet() {
  localStorage.removeItem(CONNECTED_KEY);
}

/** Signs a transaction envelope (base64 XDR) on Stellar mainnet. */
export async function signStellarTransaction(xdr: string, address: string): Promise<string> {
  const { signedTxXdr, error } = await signTransaction(xdr, {
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
    address
  });
  if (error) throw new Error(`Freighter: ${error.message}`);
  return signedTxXdr;
}
