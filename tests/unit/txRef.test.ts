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
