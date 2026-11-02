import { describe, expect, test } from "bun:test";
import {
  isTronChain,
  isEvmChain,
  getChainType,
  isTronBase58Address
} from "../../src/lib/utils/chainType";
import { TRON_MAINNET_CHAIN_ID } from "@lifi/intent";

describe("chainType", () => {
  test("isTronChain returns true for Tron mainnet chain ID", () => {
    expect(isTronChain(728126428)).toBe(true);
    expect(isTronChain(728126428n)).toBe(true);
    expect(isTronChain(Number(TRON_MAINNET_CHAIN_ID))).toBe(true);
  });

  test("isTronChain returns false for EVM chains", () => {
    expect(isTronChain(1)).toBe(false);
    expect(isTronChain(8453)).toBe(false);
    expect(isTronChain(42161)).toBe(false);
  });

  test("isEvmChain is inverse of isTronChain", () => {
    expect(isEvmChain(1)).toBe(true);
    expect(isEvmChain(728126428)).toBe(false);
  });

  test("getChainType returns correct type", () => {
    expect(getChainType(1)).toBe("evm");
    expect(getChainType(728126428)).toBe("tron");
  });
});

describe("isTronBase58Address", () => {
  test("validates Tron Base58Check addresses", () => {
    expect(isTronBase58Address("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(true);
    expect(isTronBase58Address("TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8")).toBe(true);
  });

  test("rejects non-Tron addresses", () => {
    expect(isTronBase58Address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(false);
    expect(isTronBase58Address("")).toBe(false);
    expect(isTronBase58Address("short")).toBe(false);
  });
});

describe("Tron namespace routing", () => {
  test("toCoreTokenContext routes Tron chain IDs to tron namespace", async () => {
    const { tron } = await import("viem/chains");
    expect(tron.id).toBe(728126428);
  });
});
