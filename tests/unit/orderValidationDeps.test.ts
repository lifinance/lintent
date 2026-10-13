import { describe, expect, it } from "bun:test";
import {
  COIN_FILLER,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_POLYMER_ORACLE_PDA,
  SOLANA_OUTPUT_SETTLER_PDA,
  SOLANA_POLYMER_ORACLE_PROGRAM,
  VALIDATION_ERRORS,
  addressToBytes32,
  validateOrderWithReason
} from "@lifi/intent";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex } from "viem";
import { arbitrum, base, tron } from "viem/chains";
import { CHAIN_ID_ARBITRUM, makeMandateOutput, makeStandardOrder } from "../fixtures/orderFixtures";
import { POLYMER_ORACLE, WORMHOLE_ORACLE } from "../../src/lib/config";
import { orderValidationDeps } from "../../src/lib/libraries/coreDeps";

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

describe("provider-bound Wormhole output validation", () => {
  const wormholeProgram = bytesToHex(
    new PublicKey("LiFixrxyzmt1Degd42wQCsQNhDNLjbrRwtwopX5VUrt").toBytes()
  );
  const routes = [
    { name: "Base -> Arbitrum", input: BigInt(base.id), output: BigInt(arbitrum.id) },
    { name: "Arbitrum -> Base", input: BigInt(arbitrum.id), output: BigInt(base.id) },
    { name: "Base -> Solana", input: BigInt(base.id), output: SOLANA_MAINNET_CHAIN_ID },
    { name: "Solana -> Base", input: SOLANA_MAINNET_CHAIN_ID, output: BigInt(base.id) }
  ];

  for (const route of routes) {
    const inputOracle = WORMHOLE_ORACLE[Number(route.input)]!;
    const destinationOracle = WORMHOLE_ORACLE[Number(route.output)]!;
    const settler =
      route.output === SOLANA_MAINNET_CHAIN_ID
        ? SOLANA_OUTPUT_SETTLER_PDA
        : addressToBytes32(COIN_FILLER);
    const orderWith = (oracle: `0x${string}`, originOracle = inputOracle) =>
      makeStandardOrder({
        originChainId: route.input,
        inputOracle: originOracle,
        outputs: [makeMandateOutput(route.output, 1n, { oracle, settler })]
      });

    it(`${route.name} accepts only its destination Wormhole deployment`, () => {
      const result = validateOrderWithReason({
        order: orderWith(addressToBytes32(destinationOracle)),
        deps: orderValidationDeps
      });
      expect(result.passed).toBe(true);
    });

    const wrongOracles: { name: string; oracle: `0x${string}` }[] = [
      { name: "the origin Wormhole oracle", oracle: addressToBytes32(inputOracle) },
      {
        name: "a Polymer oracle",
        oracle:
          route.output === SOLANA_MAINNET_CHAIN_ID
            ? SOLANA_POLYMER_ORACLE_PROGRAM
            : addressToBytes32(POLYMER_ORACLE[Number(route.output)]!)
      },
      { name: "the Solana Wormhole program instead of its state PDA", oracle: wormholeProgram }
    ];
    if (route.output !== SOLANA_MAINNET_CHAIN_ID) {
      wrongOracles.push({
        name: "an EVM oracle with dirty upper address bits",
        oracle: `0x01${addressToBytes32(destinationOracle).slice(4)}`
      });
    }

    for (const wrong of wrongOracles) {
      it(`${route.name} rejects ${wrong.name}`, () => {
        const result = validateOrderWithReason({
          order: orderWith(wrong.oracle),
          deps: orderValidationDeps
        });
        expect(result.passed).toBe(false);
        expect(result.reason).toBe(VALIDATION_ERRORS.INVALID_OUTPUT_ORACLE);
      });
    }

    it(`${route.name} rejects a Wormhole destination on a recorded Polymer input`, () => {
      const result = validateOrderWithReason({
        order: orderWith(addressToBytes32(destinationOracle), POLYMER_ORACLE[Number(route.input)]!),
        deps: orderValidationDeps
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toBe(VALIDATION_ERRORS.INVALID_OUTPUT_ORACLE);
    });
  }

  it("does not accept an input oracle deployed on a different Wormhole chain", () => {
    const result = validateOrderWithReason({
      order: makeStandardOrder({
        originChainId: BigInt(base.id),
        inputOracle: WORMHOLE_ORACLE[arbitrum.id]!,
        outputs: [
          makeMandateOutput(BigInt(arbitrum.id), 1n, {
            oracle: addressToBytes32(WORMHOLE_ORACLE[arbitrum.id]!)
          })
        ]
      }),
      deps: orderValidationDeps
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(VALIDATION_ERRORS.INPUT_ORACLE_NOT_ALLOWED);
  });

  it("rejects an order mixing Polymer and Wormhole output identities", () => {
    const result = validateOrderWithReason({
      order: makeStandardOrder({
        originChainId: BigInt(base.id),
        inputOracle: WORMHOLE_ORACLE[base.id]!,
        outputs: [
          makeMandateOutput(BigInt(arbitrum.id), 1n, {
            oracle: addressToBytes32(WORMHOLE_ORACLE[arbitrum.id]!)
          }),
          makeMandateOutput(SOLANA_MAINNET_CHAIN_ID, 1n, {
            oracle: SOLANA_POLYMER_ORACLE_PROGRAM,
            settler: SOLANA_OUTPUT_SETTLER_PDA
          })
        ]
      }),
      deps: orderValidationDeps
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(VALIDATION_ERRORS.INVALID_OUTPUT_ORACLE);
  });
});
