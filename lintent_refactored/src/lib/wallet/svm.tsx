"use client";
import { type ReactElement, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { getSolanaRpcUrl } from "../config/svm";
import { useSelectionStore } from "../../store/selection";

export function SolanaWalletProviders({ children }: { children: ReactNode }): ReactElement {
  const mainnet = useSelectionStore((s) => s.mainnet);
  const endpoint = getSolanaRpcUrl(mainnet);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect={false}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
