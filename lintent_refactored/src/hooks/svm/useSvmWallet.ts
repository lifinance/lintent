"use client";

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletAdapter } from "@solana/wallet-adapter-base";

type UseSvmWalletReturn = {
  publicKey: string | null;
  isConnected: boolean;
  wallets: { adapter: WalletAdapter }[];
  connect: (walletName: string) => Promise<void>;
  disconnect: () => Promise<void>;
};

export function useSvmWallet(): UseSvmWalletReturn {
  const { publicKey, connected, wallets, select, disconnect } = useWallet();

  const connectToWallet = useCallback(async (walletName: string): Promise<void> => {
    const found = wallets.find((w) => w.adapter.name === walletName);
    if (!found) throw new Error(`Wallet not found: ${walletName}`);
    select(found.adapter.name as Parameters<typeof select>[0]);
    if (!found.adapter.connected) {
      await found.adapter.connect();
    }
  }, [wallets, select]);

  return {
    publicKey: publicKey?.toBase58() ?? null,
    isConnected: connected,
    wallets,
    connect: connectToWallet,
    disconnect,
  };
}
