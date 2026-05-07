"use client";
import { useEvmWallet } from "../evm/useEvmWallet";
import { useSvmWallet } from "../svm/useSvmWallet";
import {
  WALLET_KIND_IDS,
  type WalletKindId,
  type WalletStateMap,
} from "../../lib/wallet/kinds";

export type UseMultipleWalletsReturn = {
  /** Per-kind wallet state, strongly typed by id. */
  readonly wallets: WalletStateMap;
  /** True iff every registered wallet kind is connected. */
  readonly multipleWalletsConnected: boolean;
  /** Test connection for an arbitrary subset of kinds (forward-compatible). */
  readonly areConnected: (kinds: readonly WalletKindId[]) => boolean;
};

/**
 * Aggregates every registered wallet kind into a single hook.
 *
 * Hooks rules require the per-kind hooks to be called unconditionally, so the
 * composition here is explicit. When you add a new kind to
 * `WALLET_KIND_IDS`, plug its hook in below and extend `wallets` — every
 * caller of `useMultipleWallets` automatically picks up the new kind via the
 * `multipleWalletsConnected` aggregate and `areConnected([...])` predicate.
 */
export function useMultipleWallets(): UseMultipleWalletsReturn {
  const evm = useEvmWallet();
  const svm = useSvmWallet();

  const wallets: WalletStateMap = {
    evm: {
      id: "evm",
      label: "EVM",
      isConnected: !!evm.isConnected,
      address: evm.address,
    },
    svm: {
      id: "svm",
      label: "Solana",
      isConnected: !!svm.isConnected,
      address: svm.publicKey,
    },
  };

  const multipleWalletsConnected = WALLET_KIND_IDS.every(
    (id) => wallets[id].isConnected,
  );

  const areConnected = (kinds: readonly WalletKindId[]): boolean =>
    kinds.every((id) => wallets[id].isConnected);

  return { wallets, multipleWalletsConnected, areConnected };
}
