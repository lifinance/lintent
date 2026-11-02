// Structural types for the Solana facade.
//
// Everything below is expressed against these shapes rather than the real
// @solana/web3.js and @coral-xyz/anchor types, so `writes.ts` can be unit
// tested against a hand-built mock with no SDK in the test process. Unlike
// Tron — where bun genuinely cannot load `tronweb` — the Solana SDKs do import
// under bun; the seam is kept anyway because the value is isolating the
// signer, not working around a loader.
//
// Addresses cross this boundary as base58 strings and payloads as hex or raw
// bytes. `PublicKey` and `BN` stay inside the Anchor adapter.

export type SolanaCommitment = "processed" | "confirmed" | "finalized";

export type SolanaAccountInfoLike = {
  owner: string;
  lamports: number;
  data: Uint8Array;
} | null;

export type SolanaTransactionLike = {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    logMessages: string[] | null;
  } | null;
} | null;

export type SolanaBlockhash = {
  blockhash: string;
  lastValidBlockHeight: number;
};

/** The read surface: everything the app needs from an RPC connection. */
export type SolanaConnectionLike = {
  rpcEndpoint?: string;
  getGenesisHash(): Promise<string>;
  getAccountInfo(address: string, commitment?: SolanaCommitment): Promise<SolanaAccountInfoLike>;
  getMultipleAccountsInfo(addresses: string[]): Promise<SolanaAccountInfoLike[]>;
  getTransaction(
    signature: string,
    opts?: { commitment?: SolanaCommitment }
  ): Promise<SolanaTransactionLike>;
  getBalance(address: string): Promise<bigint>;
  /** Resolves to 0n when the associated token account does not exist yet. */
  getTokenAccountBalance(address: string): Promise<bigint>;
  getLatestBlockhash(): Promise<SolanaBlockhash>;
};

export type SolanaAccountMeta = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SolanaInstructionLike = {
  programId: string;
  keys: SolanaAccountMeta[];
  data: Uint8Array;
};

/**
 * Anchor's fluent instruction builder, narrowed to what the writes layer uses.
 *
 * `accounts` takes base58 strings so callers never construct a `PublicKey`,
 * and `remainingAccounts` is explicit because `finalise` passes one attestation
 * per output and their order is load-bearing.
 */
export type SolanaInstructionBuilder = {
  accounts(accounts: Record<string, string>): SolanaInstructionBuilder;
  remainingAccounts(accounts: SolanaAccountMeta[]): SolanaInstructionBuilder;
  instruction(): Promise<SolanaInstructionLike>;
};

export type SolanaProgramLike = {
  programId: string;
  methods: Record<string, (...args: unknown[]) => SolanaInstructionBuilder>;
};

export type SolanaProgramsLike = {
  inputSettlerEscrow: SolanaProgramLike;
  outputSettlerSimple: SolanaProgramLike;
  polymer: SolanaProgramLike;
  intentsProtocol: SolanaProgramLike;
};

/**
 * The signing surface. Kept deliberately narrow: the wallet adapter signs, the
 * connection sends, and the writes layer only ever asks for "run these
 * instructions and tell me it landed".
 */
export type SolanaSignerLike = {
  /** Connected wallet address, base58. */
  publicKey: string;
  /**
   * Signs, sends and waits for the transaction. Must reject when the
   * transaction landed with an error — never resolve on absent metadata,
   * which reads as success but is only "not indexed yet".
   */
  signAndSend(
    instructions: SolanaInstructionLike[],
    opts?: { computeUnitLimit?: number }
  ): Promise<string>;
};

/**
 * Dependency bundle threaded through every write. `chainId` travels with the
 * connection deliberately: the cluster must come from the ORDER, never from a
 * UI network toggle, or a devnet order signed while the UI says mainnet goes
 * to the wrong cluster while its attestation derivation still targets the
 * right one.
 */
export type SolanaDeps = {
  chainId: bigint;
  reads: SolanaConnectionLike;
  signer: SolanaSignerLike;
  programs: SolanaProgramsLike;
};
