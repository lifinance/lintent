"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection, getSvmTokenByBytes32 } from "../../lib/config/svm";
import { useSelectionStore } from "../../store/selection";

const BYTES32_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

type UseSvmBalanceReturn = {
  balance: bigint | undefined;
  isLoading: boolean;
  error: string | null;
};

export function useSvmBalance(
  publicKeyBase58: string | null,
  mintBytes32: `0x${string}`,
): UseSvmBalanceReturn {
  const [balance, setBalance] = useState<bigint | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mainnet = useSelectionStore((s) => s.mainnet);

  useEffect(() => {
    if (!publicKeyBase58) return;

    setIsLoading(true);
    setError(null);

    const fetchBalance = async (): Promise<void> => {
      try {
        const connection = getSolanaConnection(mainnet);
        const pubkey = new PublicKey(publicKeyBase58);

        if (mintBytes32 === BYTES32_ZERO) {
          const lamports = await connection.getBalance(pubkey);
          setBalance(BigInt(lamports));
          return;
        }

        const token = getSvmTokenByBytes32(mintBytes32, mainnet);
        if (!token || !token.mintAddress) {
          const lamports = await connection.getBalance(pubkey);
          setBalance(BigInt(lamports));
          return;
        }

        const mintPubkey = new PublicKey(token.mintAddress);
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const ata = getAssociatedTokenAddressSync(mintPubkey, pubkey, false);
        const accountInfo = await connection.getAccountInfo(ata);

        if (!accountInfo) {
          setBalance(0n);
          return;
        }

        // SPL token account data: offset 64 = amount (u64 LE, 8 bytes)
        const data = accountInfo.data;
        const amountBytes = data.subarray(64, 72);
        let amount = 0n;
        for (let i = 0; i < 8; i++) {
          amount |= BigInt(amountBytes[i]) << BigInt(i * 8);
        }
        setBalance(amount);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to fetch balance");
      } finally {
        setIsLoading(false);
      }
    };

    void fetchBalance();
  }, [publicKeyBase58, mintBytes32, mainnet]);

  return { balance, isLoading, error };
}
