// Structural types for the Tron facade. Everything is expressed against
// `TronWebLike` rather than the real tronweb types so unit tests can mock the
// client without importing the package (which bun cannot load at runtime —
// see tests/fixtures/tron/PREFLIGHT.md).

export type TronTxReceipt = {
  result?: string; // "SUCCESS" | "REVERT" | "OUT_OF_ENERGY" | ...
  energy_usage_total?: number;
  net_fee?: number;
};

export type TronLogEntry = {
  address: string; // 20-byte hex, unprefixed (no 0x, no 41)
  topics: string[]; // unprefixed hex
  data?: string; // unprefixed hex
};

export type TronTxInfo = {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  result?: string; // set to "FAILED" on failure; absent on success
  resMessage?: string; // hex-encoded failure message
  receipt?: TronTxReceipt;
  contractResult?: string[];
  log?: TronLogEntry[];
};

export type TronBlock = {
  blockID?: string;
  block_header?: { raw_data?: { timestamp?: number | string } };
};

export type TronContractMethod = (...args: unknown[]) => {
  send: (opts?: Record<string, unknown>) => Promise<string>;
  call: (opts?: Record<string, unknown>) => Promise<unknown>;
};

export type TronContractInstance = Record<string, TronContractMethod>;

export type TronWebLike = {
  ready?: boolean;
  defaultAddress?: { base58: string | false; hex: string | false };
  fullNode?: { host?: string };
  trx: {
    getBalance(address: string): Promise<number>;
    /** Solidity-node query — only returns data once the tx is irreversible. */
    getTransactionInfo(txId: string): Promise<TronTxInfo>;
    /** Full-node query — returns data as soon as the tx is mined. */
    getUnconfirmedTransactionInfo?(txId: string): Promise<TronTxInfo>;
    getTransaction(txId: string): Promise<Record<string, unknown>>;
    getBlockByNumber(blockNumber: number): Promise<TronBlock>;
  };
  contract(abi: unknown[], address: string): Promise<TronContractInstance>;
  address: {
    fromHex(hex: string): string;
    toHex(base58: string): string;
  };
  setAddress?(address: string): void;
};

/**
 * Dependency bundle for Tron writes: `reads` is the always-available
 * TronGrid-backed client used for confirmation polling and state reads;
 * `signer` is the TronLink-injected instance and is only touched when a
 * transaction actually has to be signed.
 */
export type TronDeps = {
  reads: TronWebLike;
  signer: TronWebLike;
};
