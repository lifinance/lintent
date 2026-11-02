import { describe, expect, test } from "bun:test";
import { encodeFunctionData, toFunctionSelector } from "viem";
import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  TRON_MAINNET_CHAIN_ID
} from "@lifi/intent";
import { POLYMER_ORACLE_ABI } from "../../src/lib/abi/polymeroracle";
import { polymerReceiveFunction } from "../../src/lib/libraries/polymerReceive";

// A Solana proof sent to `receiveMessage` reverts with no reason string on the
// deployed Base oracle (0x008C3800F3Ad9b3B662d002E90Cc00000000eE17), because
// that entry point runs ICrossL2ProverV2.validateEvent and tries to parse the
// blob as an EVM event log. `receiveSolanaMessage` runs validateSolLogs and
// succeeds. Confirmed by simulating a real proof against both, on chain.
describe("which PolymerOracle entry point receives a proof", () => {
  test("a Solana output goes to receiveSolanaMessage", () => {
    expect(polymerReceiveFunction(SOLANA_MAINNET_CHAIN_ID)).toBe("receiveSolanaMessage");
    expect(polymerReceiveFunction(SOLANA_DEVNET_CHAIN_ID)).toBe("receiveSolanaMessage");
  });

  test("an EVM or Tron output goes to receiveMessage", () => {
    expect(polymerReceiveFunction(1)).toBe("receiveMessage");
    expect(polymerReceiveFunction(8453)).toBe("receiveMessage");
    expect(polymerReceiveFunction(TRON_MAINNET_CHAIN_ID)).toBe("receiveMessage");
  });

  // The argument is the chain the proof came FROM. A Solana fill of an
  // EVM-input order still needs the Solana entry point, even though the call
  // itself is made on the EVM input chain.
  test("selects on the output chain, not the chain being called", () => {
    const solanaOutputEvmInput = polymerReceiveFunction(SOLANA_MAINNET_CHAIN_ID);
    expect(solanaOutputEvmInput).toBe("receiveSolanaMessage");
  });

  test("the ABI carries both entry points, and they are different functions", () => {
    // 0xf953cec7 is what reverted in the field — pinned so a regression to it
    // is unmistakable.
    expect(toFunctionSelector("receiveMessage(bytes)")).toBe("0xf953cec7");
    expect(toFunctionSelector("receiveSolanaMessage(bytes)")).not.toBe("0xf953cec7");

    const proof = `0x${"ab".repeat(64)}` as const;
    const evm = encodeFunctionData({
      abi: POLYMER_ORACLE_ABI,
      functionName: "receiveMessage",
      args: [proof]
    });
    const solana = encodeFunctionData({
      abi: POLYMER_ORACLE_ABI,
      functionName: "receiveSolanaMessage",
      args: [proof]
    });

    expect(evm.slice(0, 10)).toBe("0xf953cec7");
    expect(solana.slice(0, 10)).toBe(toFunctionSelector("receiveSolanaMessage(bytes)"));
    expect(solana.slice(0, 10)).not.toBe(evm.slice(0, 10));
  });
});
