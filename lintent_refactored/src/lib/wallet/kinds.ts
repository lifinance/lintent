/**
 * Wallet-kind registry.
 *
 * The frontend supports multiple wallet kinds in parallel (currently EVM and
 * Solana). Adding a new kind — say Bitcoin or Aptos — is a four-step process:
 *
 *  1. Extend the `WalletKindId` union below.
 *  2. Add the kind to `WALLET_KIND_IDS`.
 *  3. Define a typed `*WalletState` for it (`address` shape varies per VM).
 *  4. Wire the underlying hook into `useMultipleWallets` and a button into
 *     `WalletConnectBar`'s component map.
 *
 * Keeping the contract centralised here avoids spraying `evm` / `svm` literals
 * through call sites. Aggregations (`multipleWalletsConnected`,
 * `areConnected(kinds)`) iterate over the registry, so they pick up new kinds
 * for free once steps 1–4 are done.
 */

export type WalletKindId = "evm" | "svm";

/** All registered wallet-kind ids — iterate over this for aggregations. */
export const WALLET_KIND_IDS = ["evm", "svm"] as const satisfies readonly WalletKindId[];

type BaseWalletState<Id extends WalletKindId, Addr> = {
  readonly id: Id;
  readonly label: string;
  readonly isConnected: boolean;
  /** The address/pubkey of the connected account, or a falsy value when not connected. */
  readonly address: Addr;
};

export type EvmWalletState = BaseWalletState<"evm", `0x${string}` | undefined>;
export type SvmWalletState = BaseWalletState<"svm", string | null>;

/**
 * Strongly-typed map of every wallet kind to its state.
 * Each entry preserves its address shape (e.g. `0x${string}` for EVM).
 */
export type WalletStateMap = {
  readonly evm: EvmWalletState;
  readonly svm: SvmWalletState;
};

/** Discriminated union covering every kind — use when iterating generically. */
export type WalletState = WalletStateMap[WalletKindId];
