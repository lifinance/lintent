import { describe, expect, test } from "bun:test";
import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  TRON_MAINNET_CHAIN_ID
} from "@lifi/intent";
import {
  SOLANA_CHAIN_IDS,
  getChainType,
  isEvmChain,
  isSolanaChain,
  isSolanaMainnet,
  isTronChain
} from "../../src/lib/utils/chainType";

describe("chainType (solana)", () => {
  test("isSolanaChain accepts every solana chain id, as number and bigint", () => {
    for (const chainId of [
      SOLANA_MAINNET_CHAIN_ID,
      SOLANA_TESTNET_CHAIN_ID,
      SOLANA_DEVNET_CHAIN_ID
    ]) {
      expect(isSolanaChain(chainId)).toBe(true);
      expect(isSolanaChain(Number(chainId))).toBe(true);
    }
  });

  test("isSolanaChain rejects evm and tron chains", () => {
    for (const chainId of [1, 8453, 42161, Number(TRON_MAINNET_CHAIN_ID)]) {
      expect(isSolanaChain(chainId)).toBe(false);
    }
  });

  test("getChainType classifies all three namespaces", () => {
    expect(getChainType(1)).toBe("evm");
    expect(getChainType(TRON_MAINNET_CHAIN_ID)).toBe("tron");
    expect(getChainType(SOLANA_MAINNET_CHAIN_ID)).toBe("solana");
  });

  test("isEvmChain is false for solana", () => {
    // Regression guard: isEvmChain used to be `!isTronChain`, which reported
    // every Solana chain as EVM and silently routed it down the viem path.
    expect(isEvmChain(SOLANA_MAINNET_CHAIN_ID)).toBe(false);
    expect(isEvmChain(SOLANA_DEVNET_CHAIN_ID)).toBe(false);
    expect(isEvmChain(TRON_MAINNET_CHAIN_ID)).toBe(false);
    expect(isEvmChain(1)).toBe(true);
  });

  test("the three chain-type predicates are mutually exclusive", () => {
    for (const chainId of [
      1,
      8453,
      Number(TRON_MAINNET_CHAIN_ID),
      Number(SOLANA_MAINNET_CHAIN_ID),
      Number(SOLANA_DEVNET_CHAIN_ID)
    ]) {
      const matches = [isEvmChain(chainId), isTronChain(chainId), isSolanaChain(chainId)].filter(
        Boolean
      );
      expect(matches).toHaveLength(1);
    }
  });

  test("solana chain ids survive the Number() round trip exactly", () => {
    // The Set<number> lookup in chainType.ts is only sound while these stay
    // inside Number.MAX_SAFE_INTEGER (~9.0e15). They are ~1.15e15 today.
    for (const chainId of SOLANA_CHAIN_IDS) {
      expect(Number.isSafeInteger(Number(chainId))).toBe(true);
      expect(BigInt(Number(chainId))).toBe(chainId);
    }
  });

  test("isSolanaMainnet distinguishes mainnet from devnet", () => {
    expect(isSolanaMainnet(SOLANA_MAINNET_CHAIN_ID)).toBe(true);
    expect(isSolanaMainnet(SOLANA_DEVNET_CHAIN_ID)).toBe(false);
    expect(isSolanaMainnet(1)).toBe(false);
  });

  test("SOLANA_CHAIN_IDS is the single source of truth", () => {
    expect(SOLANA_CHAIN_IDS.size).toBe(3);
    for (const chainId of SOLANA_CHAIN_IDS) {
      expect(isSolanaChain(chainId)).toBe(true);
    }
  });
});
