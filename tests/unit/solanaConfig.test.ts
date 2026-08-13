import { describe, expect, test } from "bun:test";
import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_OUTPUT_SETTLER_PDA,
  SOLANA_POLYMER_ORACLE_PDA,
  SOLANA_POLYMER_ORACLE_PROGRAM
} from "@lifi/intent";
import {
  SOLANA_OUTPUT_SETTLER,
  SOLANA_POLYMER_OUTPUT_ORACLE,
  chainMetaById,
  getChain,
  getChainName,
  getClient,
  getOracle,
  isChainIdTestnet
} from "../../src/lib/config";

const SOLANA_IDS = [SOLANA_MAINNET_CHAIN_ID, SOLANA_DEVNET_CHAIN_ID];

describe("config (solana)", () => {
  test("getChainName no longer throws for solana chains", () => {
    // Before the ChainMeta registry these read chainNameById, which is derived
    // from chainMap (viem chains only) and threw — blowing up every screen
    // that renders a chain name for a Solana order.
    expect(getChainName(SOLANA_MAINNET_CHAIN_ID)).toBe("solana");
    expect(getChainName(SOLANA_DEVNET_CHAIN_ID)).toBe("solanaDevnet");
  });

  test("isChainIdTestnet classifies solana clusters", () => {
    expect(isChainIdTestnet(SOLANA_MAINNET_CHAIN_ID)).toBe(false);
    expect(isChainIdTestnet(SOLANA_DEVNET_CHAIN_ID)).toBe(true);
  });

  test("chainMetaById covers both EVM and solana chains", () => {
    expect(chainMetaById[1]?.type).toBe("evm");
    expect(chainMetaById[Number(SOLANA_MAINNET_CHAIN_ID)]?.type).toBe("solana");
    expect(chainMetaById[728126428]?.type).toBe("tron");
  });

  test("getChain and getClient still refuse solana, with a chain-type message", () => {
    // These return viem values with no Solana analogue. The message must name
    // the chain type so a missing branch is obvious at the call site.
    for (const chainId of SOLANA_IDS) {
      expect(() => getChain(chainId)).toThrow(/is a solana chain, not an EVM chain/);
      expect(() => getClient(chainId)).toThrow(/is a solana chain, not an EVM chain/);
    }
  });

  test("getOracle returns the polymer PDA for a solana input chain", () => {
    for (const chainId of SOLANA_IDS) {
      expect(getOracle("polymer", chainId)).toBe(SOLANA_POLYMER_ORACLE_PDA);
    }
  });

  test("the input oracle and the output oracle are different values", () => {
    // The single most likely silent failure: an order that fills and can then
    // never be proven. Input side wants the PDA, output side the program id.
    expect(SOLANA_POLYMER_OUTPUT_ORACLE).toBe(SOLANA_POLYMER_ORACLE_PROGRAM);
    expect(SOLANA_POLYMER_OUTPUT_ORACLE).not.toBe(SOLANA_POLYMER_ORACLE_PDA);
    expect(getOracle("polymer", SOLANA_MAINNET_CHAIN_ID)).not.toBe(SOLANA_POLYMER_OUTPUT_ORACLE);
  });

  test("the solana output settler is the settler PDA", () => {
    expect(SOLANA_OUTPUT_SETTLER).toBe(SOLANA_OUTPUT_SETTLER_PDA);
    expect(SOLANA_OUTPUT_SETTLER).not.toBe(SOLANA_POLYMER_OUTPUT_ORACLE);
  });

  test("solana chains are absent from the viem chain map", () => {
    // Keeping them out of chainMap is deliberate: it feeds wagmiChains and
    // clientsById. A Solana entry would appear in wallet switch-chain menus
    // and produce a viem client aimed at a Solana RPC.
    for (const chainId of SOLANA_IDS) {
      expect(chainMetaById[Number(chainId)]).toBeDefined();
      expect(() => getClient(chainId)).toThrow();
    }
  });
});
