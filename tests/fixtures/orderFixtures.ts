import type { MandateOutput, MultichainOrder, StandardOrder } from "@lifi/intent";
import { COIN_FILLER, addressToBytes32 } from "@lifi/intent";
import { POLYMER_ORACLE } from "../../src/lib/config";

export const CHAIN_ID_ETHEREUM = 1n;
export const CHAIN_ID_ARBITRUM = 42161n;
export const CHAIN_ID_BASE = 8453n;

// Derived from config rather than hardcoded: a redeployment that updates
// POLYMER_ORACLE must not leave the fixtures silently on a dead oracle.
const ethereumPolymerOracle = POLYMER_ORACLE[Number(CHAIN_ID_ETHEREUM)];
if (!ethereumPolymerOracle) throw new Error("POLYMER_ORACLE missing an ethereum entry");
export const TEST_POLYMER_ORACLE: `0x${string}` = ethereumPolymerOracle;

export const TEST_USER: `0x${string}` = "0x1111111111111111111111111111111111111111";
export const TEST_NOW_SECONDS = 1_700_000_000;

export const b32 = (nibble: string): `0x${string}` => `0x${nibble.repeat(64)}`;

export function makeMandateOutput(
  chainId = CHAIN_ID_ARBITRUM,
  amount = 1n,
  overrides: Partial<MandateOutput> = {}
): MandateOutput {
  return {
    oracle: addressToBytes32(COIN_FILLER),
    settler: addressToBytes32(COIN_FILLER),
    chainId,
    token: b32("3"),
    amount,
    recipient: b32("4"),
    callbackData: "0x",
    context: "0x",
    ...overrides
  };
}

export function makeStandardOrder(overrides: Partial<StandardOrder> = {}): StandardOrder {
  return {
    user: TEST_USER,
    nonce: 1n,
    originChainId: CHAIN_ID_ETHEREUM,
    expires: TEST_NOW_SECONDS + 1000,
    fillDeadline: TEST_NOW_SECONDS + 900,
    inputOracle: TEST_POLYMER_ORACLE,
    inputs: [[1n, 1n]],
    outputs: [makeMandateOutput(CHAIN_ID_ARBITRUM)],
    ...overrides
  };
}

export function makeMultichainOrder(overrides: Partial<MultichainOrder> = {}): MultichainOrder {
  return {
    user: TEST_USER,
    nonce: 2n,
    expires: TEST_NOW_SECONDS + 1000,
    fillDeadline: TEST_NOW_SECONDS + 900,
    inputOracle: TEST_POLYMER_ORACLE,
    outputs: [makeMandateOutput(CHAIN_ID_BASE, 2n)],
    inputs: [
      { chainId: CHAIN_ID_ETHEREUM, inputs: [[1n, 1n]] },
      { chainId: CHAIN_ID_ARBITRUM, inputs: [[2n, 2n]] }
    ],
    ...overrides
  };
}
