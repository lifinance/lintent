import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

export type { Connection } from "@solana/web3.js";

/**
 * Minimal wallet interface accepted by AnchorProvider.
 * Solana wallet adapters (Phantom, Solflare) implement these at runtime
 * but the base `Adapter` type from @solana/wallet-adapter-base does not
 * expose them statically. Call sites cast the adapter to this interface.
 */
export interface SigningWalletAdapter {
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

export interface AnchorCompatibleWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

export function toAnchorWallet(
  publicKey: PublicKey,
  adapter: SigningWalletAdapter,
): AnchorCompatibleWallet {
  return {
    publicKey,
    signTransaction: <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> =>
      adapter.signTransaction(tx),
    signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> =>
      adapter.signAllTransactions(txs),
  };
}
