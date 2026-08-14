import { describe, expect, test } from "bun:test";
import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  TRON_MAINNET_CHAIN_ID
} from "@lifi/intent";
import { base58 } from "@scure/base";
import {
  isValidTxRef,
  normalizeTxRef,
  txRefError,
  txRefPlaceholder
} from "../../src/lib/utils/txRef";

const EVM_HASH = `0x${"ab".repeat(32)}`;
const BARE_HASH = "ab".repeat(32);
const SOLANA_SIG = base58.encode(new Uint8Array(64).fill(7));
const SOLANA_PUBKEY = base58.encode(new Uint8Array(32).fill(7));

describe("isValidTxRef", () => {
  test("accepts a 0x hash on EVM chains", () => {
    expect(isValidTxRef(EVM_HASH, 1)).toBe(true);
    expect(isValidTxRef(BARE_HASH, 1)).toBe(false);
  });

  test("accepts both prefixed and bare hashes on Tron", () => {
    // Tron reports transaction ids without the 0x prefix.
    expect(isValidTxRef(EVM_HASH, TRON_MAINNET_CHAIN_ID)).toBe(true);
    expect(isValidTxRef(BARE_HASH, TRON_MAINNET_CHAIN_ID)).toBe(true);
  });

  test("accepts a 64-byte base58 signature on Solana", () => {
    expect(isValidTxRef(SOLANA_SIG, SOLANA_MAINNET_CHAIN_ID)).toBe(true);
    expect(isValidTxRef(SOLANA_SIG, SOLANA_DEVNET_CHAIN_ID)).toBe(true);
  });

  test("rejects a 32-byte base58 value on Solana", () => {
    // Valid base58 that decodes to a pubkey, not a signature — a length-only
    // check would wave this through.
    expect(isValidTxRef(SOLANA_PUBKEY, SOLANA_MAINNET_CHAIN_ID)).toBe(false);
  });

  test("rejects an EVM hash on Solana and a Solana signature on EVM", () => {
    // The trap this type exists to prevent: a fill reference belongs to the
    // OUTPUT chain, so validating it against the wrong chain silently accepts
    // or rejects the wrong thing.
    expect(isValidTxRef(EVM_HASH, SOLANA_MAINNET_CHAIN_ID)).toBe(false);
    expect(isValidTxRef(SOLANA_SIG, 1)).toBe(false);
  });

  test("rejects empty and undefined", () => {
    expect(isValidTxRef(undefined, 1)).toBe(false);
    expect(isValidTxRef("", SOLANA_MAINNET_CHAIN_ID)).toBe(false);
  });
});

describe("normalizeTxRef", () => {
  test("prefixes a bare Tron hash", () => {
    expect(normalizeTxRef(BARE_HASH, TRON_MAINNET_CHAIN_ID)).toBe(EVM_HASH);
  });

  test("leaves a Solana signature untouched", () => {
    // base58 is case-sensitive and has no prefix; touching it corrupts it.
    expect(normalizeTxRef(SOLANA_SIG, SOLANA_MAINNET_CHAIN_ID)).toBe(SOLANA_SIG);
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeTxRef(`  ${EVM_HASH}  `, 1)).toBe(EVM_HASH);
  });
});

describe("messages", () => {
  test("placeholder and error text are chain-appropriate", () => {
    expect(txRefPlaceholder(SOLANA_MAINNET_CHAIN_ID)).toContain("base58");
    expect(txRefPlaceholder(1)).toBe("0x...");
    expect(txRefError(SOLANA_MAINNET_CHAIN_ID)).toContain("base58");
    expect(txRefError(1)).toContain("32-byte");
  });
});

describe("the signature the claim path rejected", () => {
  // Regression: Solver.claim validated fill hashes with a hardcoded
  // `startsWith("0x") && length === 66`, which the txRef refactor missed. A
  // real devnet fill signature was rejected as "Invalid fill tx hash at index
  // 0" even though the fill had landed, stranding the order before finalise.
  const REAL_FILL_SIGNATURE =
    "5B72eWR4yk58nkmJFcGDXtRi3KS9EHNuZgQSSwXnYQPJnuCtrC4U6aV3wPTopQAATkxkmDcxBqwxPyJ6CVpMRfkQ";

  test("is a well-formed 64-byte Solana signature", () => {
    expect(base58.decode(REAL_FILL_SIGNATURE).length).toBe(64);
  });

  test("is accepted for a Solana output chain", () => {
    expect(isValidTxRef(REAL_FILL_SIGNATURE, SOLANA_DEVNET_CHAIN_ID)).toBe(true);
    expect(isValidTxRef(REAL_FILL_SIGNATURE, SOLANA_MAINNET_CHAIN_ID)).toBe(true);
  });

  test("fails the old hardcoded EVM check, which is why the bug existed", () => {
    const oldCheck = (h: string) => h.startsWith("0x") && h.length === 66;
    expect(oldCheck(REAL_FILL_SIGNATURE)).toBe(false);
  });

  test("is still rejected when the output chain is EVM", () => {
    // The fill hash belongs to output.chainId, so passing an EVM chain here
    // must reject — a base58 signature on an EVM output is genuinely wrong.
    expect(isValidTxRef(REAL_FILL_SIGNATURE, 8453)).toBe(false);
  });
});
