import { describe, expect, it } from "bun:test";
import {
  COIN_FILLER,
  STELLAR_MAINNET_CHAIN_ID,
  VALIDATION_ERRORS,
  addressToBytes32,
  outputSettlerForStellar,
  validateOrderWithReason
} from "@lifi/intent";
import {
  CHAIN_ID_BASE,
  TEST_POLYMER_ORACLE,
  b32,
  makeMandateOutput,
  makeStandardOrder
} from "../fixtures/orderFixtures";
import { orderValidationDeps } from "../../src/lib/libraries/coreDeps";

const BASE_AXELAR_ORACLE = "0xb7eA767b54aF5Dd8AD12Df648A399F9075D93FeE" as const;
const STELLAR_AXELAR_ORACLE =
  "0x2a9746edd91c73f4c63b95ef626f0d0ad40ac6901dba0686f4a5fed64c359048" as const;

describe("orderValidationDeps Axelar routes", () => {
  const baseToStellar = (oracle: `0x${string}`) =>
    makeStandardOrder({
      originChainId: CHAIN_ID_BASE,
      inputOracle: BASE_AXELAR_ORACLE,
      outputs: [
        makeMandateOutput(STELLAR_MAINNET_CHAIN_ID, 10_000_000n, {
          oracle,
          settler: outputSettlerForStellar(STELLAR_MAINNET_CHAIN_ID),
          context: "0x00"
        })
      ]
    });

  it("accepts a Base->Stellar order proven by the Stellar Axelar oracle", () => {
    const result = validateOrderWithReason({
      order: baseToStellar(STELLAR_AXELAR_ORACLE),
      deps: orderValidationDeps
    });
    expect(result.reason).toBe("");
    expect(result.passed).toBe(true);
  });

  it("rejects a Stellar output whose oracle is not deployed on Stellar", () => {
    const result = validateOrderWithReason({
      order: baseToStellar(addressToBytes32(TEST_POLYMER_ORACLE)),
      deps: orderValidationDeps
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(VALIDATION_ERRORS.INVALID_OUTPUT_ORACLE);
  });

  it("rejects a Stellar output settled by the EVM output settler", () => {
    const order = baseToStellar(STELLAR_AXELAR_ORACLE);
    order.outputs[0].settler = addressToBytes32(COIN_FILLER);
    const result = validateOrderWithReason({ order, deps: orderValidationDeps });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(VALIDATION_ERRORS.INVALID_OUTPUT_SETTLER);
  });

  it("accepts a Stellar->Base order proven by the Base Axelar oracle", () => {
    const result = validateOrderWithReason({
      order: makeStandardOrder({
        user: b32("1"),
        originChainId: STELLAR_MAINNET_CHAIN_ID,
        inputOracle: STELLAR_AXELAR_ORACLE,
        outputs: [
          makeMandateOutput(CHAIN_ID_BASE, 1_000_000n, {
            oracle: addressToBytes32(BASE_AXELAR_ORACLE),
            settler: addressToBytes32(COIN_FILLER)
          })
        ]
      }),
      deps: orderValidationDeps
    });
    expect(result.reason).toBe("");
    expect(result.passed).toBe(true);
  });
});

describe("orderValidationDeps unknown-chain handling", () => {
  it("rejects unsupported origin chains even when same-chain fill uses COIN_FILLER", () => {
    const unknownChainId = 999999999n;
    const result = validateOrderWithReason({
      order: makeStandardOrder({
        originChainId: unknownChainId,
        inputOracle: COIN_FILLER,
        outputs: [
          makeMandateOutput(unknownChainId, 1n, {
            oracle: addressToBytes32(COIN_FILLER),
            settler: addressToBytes32(COIN_FILLER),
            context: "0x00"
          })
        ]
      }),
      deps: orderValidationDeps
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(VALIDATION_ERRORS.UNKNOWN_ORIGIN_CHAIN);
  });

  it("rejects unsupported output chains instead of treating them as COIN_FILLER-only", () => {
    const unknownChainId = 999999999n;
    const result = validateOrderWithReason({
      order: makeStandardOrder({
        outputs: [
          makeMandateOutput(unknownChainId, 1n, {
            oracle: addressToBytes32(COIN_FILLER),
            settler: addressToBytes32(COIN_FILLER),
            context: "0x00"
          })
        ]
      }),
      deps: orderValidationDeps
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(VALIDATION_ERRORS.UNKNOWN_OUTPUT_CHAIN);
  });
});
