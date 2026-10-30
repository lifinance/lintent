import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction
} from "@stellar/freighter-api";
import { stellarNetwork } from "$lib/config";

// Freighter has no programmatic disconnect; this flag decides whether a reload
// restores the account.
const CONNECTED_KEY = "lintent:stellar-connected";
const FREIGHTER_URL = "https://www.freighter.app/";

/** Requests access from Freighter and returns the connected account (`G…`). */
export async function connectStellarWallet(chainId: number): Promise<string> {
  const selected = stellarNetwork(chainId);
  const { isConnected: installed } = await isConnected();
  if (!installed) {
    window.open(FREIGHTER_URL, "_blank");
    throw new Error("Freighter extension not found");
  }

  const { address, error } = await requestAccess();
  if (error) throw new Error(`Freighter: ${error.message}`);

  const network = await getNetworkDetails();
  if (network.error) throw new Error(`Freighter: ${network.error.message}`);
  if (network.networkPassphrase !== selected.passphrase) {
    throw new Error(`Switch Freighter to ${selected.name}`);
  }

  localStorage.setItem(`${CONNECTED_KEY}:${chainId}`, "1");
  return address;
}

/** Returns the previously connected account, or undefined if none is available. */
export async function restoreStellarWallet(chainId: number): Promise<string | undefined> {
  if (localStorage.getItem(`${CONNECTED_KEY}:${chainId}`) !== "1") return undefined;
  const network = await getNetworkDetails();
  if (network.error || network.networkPassphrase !== stellarNetwork(chainId).passphrase)
    return undefined;
  // Empty when the site is not allowed or Freighter is locked.
  const { address, error } = await getAddress();
  if (error || !address) return undefined;
  return address;
}

export async function disconnectStellarWallet(chainId: number) {
  localStorage.removeItem(`${CONNECTED_KEY}:${chainId}`);
}

/** Signs only under the selected network; recheck Freighter immediately before signing. */
export async function signStellarTransaction(
  xdr: string,
  address: string,
  chainId: number
): Promise<string> {
  const selected = stellarNetwork(chainId);
  const network = await getNetworkDetails();
  if (network.error || network.networkPassphrase !== selected.passphrase)
    throw new Error(`Switch Freighter to ${selected.name}`);
  const { signedTxXdr, error } = await signTransaction(xdr, {
    networkPassphrase: selected.passphrase,
    address
  });
  if (error) throw new Error(`Freighter: ${error.message}`);
  return signedTxXdr;
}
