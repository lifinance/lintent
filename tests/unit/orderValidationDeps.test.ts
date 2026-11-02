import { describe, expect, it } from "bun:test";
import {
  COIN_FILLER,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_POLYMER_ORACLE_PDA,
  STELLAR_MAINNET_CHAIN_ID,
  VALIDATION_ERRORS,
  addressToBytes32,
  outputSettlerForStellar,
  stellarStrkeyToBytes32,
  STELLAR_TESTNET_CHAIN_ID,
  validateOrderWithReason,
  type OrderContainer,
  type StandardOrder
} from "@lifi/intent";
import { arbitrum, base, tron } from "viem/chains";
import {
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_BASE,
  TEST_POLYMER_ORACLE,
  b32,
  makeMandateOutput,
  makeStandardOrder
} from "../fixtures/orderFixtures";
import { POLYMER_ORACLE, getCoin } from "../../src/lib/config";
import { axelarActionBlocker, orderValidationDeps } from "../../src/lib/libraries/coreDeps";
import { AXELAR_NETWORKS } from "../../src/lib/axelarNetworks";

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

const ARBITRUM_ORACLE = POLYMER_ORACLE[arbitrum.id]!;
const BASE_ORACLE = POLYMER_ORACLE[base.id]!;
const TRON_ORACLE = POLYMER_ORACLE[tron.id]!;

/** A Solana-origin order whose single output sits on an EVM chain. */
function solanaOriginOrder(outputOracle: `0x${string}`, inputOracle = SOLANA_POLYMER_ORACLE_PDA) {
  return makeStandardOrder({
    originChainId: SOLANA_MAINNET_CHAIN_ID,
    inputOracle,
    outputs: [
      makeMandateOutput(CHAIN_ID_ARBITRUM, 1n, {
        oracle: outputOracle,
        settler: addressToBytes32(COIN_FILLER)
      })
    ]
  });
}

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

describe("allowedOutputOracles on a solana-origin order", () => {
  it("accepts the EVM output chain's polymer oracle", () => {
    // The value @lifi/intent >=0.5.0 emits. The input chain's PDA cannot be
    // used: the EVM settler reverts HasDirtyBits() on it.
    const result = validateOrderWithReason({
      order: solanaOriginOrder(addressToBytes32(ARBITRUM_ORACLE)),
      deps: orderValidationDeps
    });

    expect(result.passed).toBe(true);
  });

  it("still accepts the legacy solana input PDA so old orders stay renderable", () => {
    const result = validateOrderWithReason({
      order: solanaOriginOrder(SOLANA_POLYMER_ORACLE_PDA),
      deps: orderValidationDeps
    });

    expect(result.passed).toBe(true);
  });

  it("rejects an output oracle belonging to neither side of the route", () => {
    const result = validateOrderWithReason({
      order: solanaOriginOrder(addressToBytes32(TRON_ORACLE)),
      deps: orderValidationDeps
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(VALIDATION_ERRORS.INVALID_OUTPUT_ORACLE);
  });

  it("keeps requiring the input chain oracle for an EVM-origin order", () => {
    const wrong = validateOrderWithReason({
      order: makeStandardOrder({
        originChainId: BigInt(base.id),
        inputOracle: BASE_ORACLE,
        outputs: [
          makeMandateOutput(CHAIN_ID_ARBITRUM, 1n, {
            oracle: SOLANA_POLYMER_ORACLE_PDA,
            settler: addressToBytes32(COIN_FILLER)
          })
        ]
      }),
      deps: orderValidationDeps
    });

    expect(wrong.passed).toBe(false);

    const right = validateOrderWithReason({
      order: makeStandardOrder({
        originChainId: BigInt(base.id),
        inputOracle: BASE_ORACLE,
        outputs: [
          makeMandateOutput(CHAIN_ID_ARBITRUM, 1n, {
            oracle: addressToBytes32(BASE_ORACLE),
            settler: addressToBytes32(COIN_FILLER)
          })
        ]
      }),
      deps: orderValidationDeps
    });

    expect(right.passed).toBe(true);
  });
});

describe("Stellar corridor configuration", () => {
  const container = (order: StandardOrder): OrderContainer => ({
    order,
    inputSettler: "0x0000000000000000000000000000000000000001",
    sponsorSignature: { type: "None", payload: "0x" },
    allocatorSignature: { type: "None", payload: "0x" }
  });
  it("keeps Axelar writes open on the mainnet corridor and blocks unsupported pairs", () => {
    const toStellar = makeStandardOrder({
      originChainId: CHAIN_ID_BASE,
      inputOracle: BASE_AXELAR_ORACLE,
      outputs: [
        makeMandateOutput(STELLAR_MAINNET_CHAIN_ID, 1n, {
          oracle: STELLAR_AXELAR_ORACLE,
          settler: outputSettlerForStellar(STELLAR_MAINNET_CHAIN_ID)
        })
      ]
    });
    expect(axelarActionBlocker(container(toStellar))).toBeUndefined();
    const toTestnet = makeStandardOrder({
      originChainId: CHAIN_ID_BASE,
      inputOracle: BASE_AXELAR_ORACLE,
      outputs: [makeMandateOutput(STELLAR_TESTNET_CHAIN_ID, 1n, { oracle: STELLAR_AXELAR_ORACLE })]
    });
    expect(axelarActionBlocker(container(toTestnet))).toContain("Unsupported Axelar corridor");
  });
  it("keeps full-width testnet SAC identity and seven decimals in historical display", () => {
    const address = stellarStrkeyToBytes32(AXELAR_NETWORKS.testnet.stellar.usdc);
    const token = getCoin({ chainId: STELLAR_TESTNET_CHAIN_ID, address });
    expect(token.address).toBe(address);
    expect(token.decimals).toBe(7);
    expect(
      getCoin({ chainId: STELLAR_TESTNET_CHAIN_ID, address: `0x${address.slice(-40)}` }).name
    ).toBe("Unknown");
    expect(getCoin({ chainId: 84532, name: "usdc" }).decimals).toBe(6);
  });
});
