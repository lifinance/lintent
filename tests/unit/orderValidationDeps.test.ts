import { describe, expect, it } from "bun:test";
import {
  COIN_FILLER,
  STELLAR_MAINNET_CHAIN_ID,
  VALIDATION_ERRORS,
  addressToBytes32,
  outputSettlerForStellar,
  stellarStrkeyToBytes32,
  STELLAR_TESTNET_CHAIN_ID,
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
import { loadStellarTestnet, parseStellarTestnetDeployment } from "../../src/lib/stellarTestnet";
import { StrKey } from "@stellar/stellar-sdk";
import { axelarActionBlocker } from "../../src/lib/libraries/coreDeps";
import { getAddress } from "viem";
import { getCoin } from "../../src/lib/config";
import { STELLAR_TESTNET_USDC } from "../../src/lib/stellarTestnet";

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

describe("Stellar testnet configuration safety", () => {
  const synthetic = {
    schemaVersion: 1,
    corridor: "stellar-testnet-base-sepolia",
    addressProvenance: "predicted",
    stellar: {
      inputEscrow: StrKey.encodeContract(Buffer.alloc(32, 1)),
      outputSettler: StrKey.encodeContract(Buffer.alloc(32, 2)),
      axelarOracle: StrKey.encodeContract(Buffer.alloc(32, 3))
    },
    baseSepolia: { axelarOracle: "0x123456789012345678901234567890123456789a" }
  };
  it("requires deployment-record provenance only when enabled", () => {
    expect(loadStellarTestnet().enabled).toBe(false);
    expect(orderValidationDeps.allowedOutputSettlers(STELLAR_TESTNET_CHAIN_ID)).toEqual([]);
    expect(
      orderValidationDeps.allowedInputOracles({
        chainId: STELLAR_TESTNET_CHAIN_ID,
        sameChainFill: false
      })
    ).toBeUndefined();
    expect(
      loadStellarTestnet("false", JSON.stringify(synthetic)).deployment?.addressProvenance
    ).toBe("predicted");
    expect(() => loadStellarTestnet("true", JSON.stringify(synthetic))).toThrow(
      "deployment-record"
    );
    expect(() => loadStellarTestnet("true")).toThrow("deployment-record");
    expect(
      loadStellarTestnet(
        "true",
        JSON.stringify({ ...synthetic, addressProvenance: "deployment-record" })
      ).enabled
    ).toBe(true);
  });
  it("rejects malformed supplied configuration even when disabled", () => {
    for (const text of [
      "",
      "{",
      "null",
      JSON.stringify({ ...synthetic, schemaVersion: 2 }),
      JSON.stringify({ ...synthetic, secret: "not-allowed" })
    ])
      expect(() => loadStellarTestnet("false", text)).toThrow();
    expect(() => loadStellarTestnet("yes")).toThrow();
  });
  it("rejects every known Stellar mainnet deployment in every contract role", () => {
    const mainnet = [
      "CA5GTK5U5LYGWIJSAG6LD724NUDFONHVEHYOHOH5KWCKCX5I442QYLUN",
      "CBNYANRIUUUTAZJSEA2FEYUHFPUNRRYPUP6URIZIG2PZXTWWYSXLL3SX",
      "CCIJYT5LJBNO5WHW5OJILTLQXSPC5CZWGCNT5B2MSXD2FDV6VIU7UMPT",
      "CAVJORXN3EOHH5GGHOK66YTPBUFNICWGSAO3UBUG6SS75VSMGWIEQX4V"
    ];
    for (const role of ["inputEscrow", "outputSettler", "axelarOracle"])
      for (const address of [
        ...mainnet,
        StrKey.encodeContract(Buffer.alloc(32)),
        StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1))
      ])
        expect(() =>
          parseStellarTestnetDeployment(
            JSON.stringify({ ...synthetic, stellar: { ...synthetic.stellar, [role]: address } })
          )
        ).toThrow();
  });
  it("normalizes lowercase EVM input and rejects zero/mainnet/malformed oracles", () => {
    expect(parseStellarTestnetDeployment(JSON.stringify(synthetic)).baseSepolia.axelarOracle).toBe(
      "0x123456789012345678901234567890123456789a"
    );
    expect(
      parseStellarTestnetDeployment(
        JSON.stringify({
          ...synthetic,
          baseSepolia: { axelarOracle: getAddress(synthetic.baseSepolia.axelarOracle) }
        })
      ).baseSepolia.axelarOracle
    ).toBe("0x123456789012345678901234567890123456789a");
    for (const address of [
      "0x0000000000000000000000000000000000000000",
      "0xb7eA767b54aF5Dd8AD12Df648A399F9075D93FeE",
      "0x1234",
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96044"
    ])
      expect(() =>
        parseStellarTestnetDeployment(
          JSON.stringify({ ...synthetic, baseSepolia: { axelarOracle: address } })
        )
      ).toThrow();
  });
  it("retains historical validation but blocks old Axelar writes", () => {
    const order = makeStandardOrder({
      originChainId: CHAIN_ID_BASE,
      inputOracle: BASE_AXELAR_ORACLE,
      outputs: [
        makeMandateOutput(STELLAR_MAINNET_CHAIN_ID, 1n, {
          oracle: STELLAR_AXELAR_ORACLE,
          settler: outputSettlerForStellar(STELLAR_MAINNET_CHAIN_ID)
        })
      ]
    });
    expect(
      axelarActionBlocker({
        order,
        inputSettler: "0x0000000000000000000000000000000000000001",
        sponsorSignature: { type: "None", payload: "0x" },
        allocatorSignature: { type: "None", payload: "0x" }
      })
    ).toContain("old-ABI");
  });
  it("keeps full-width testnet SAC identity and seven decimals in historical display", () => {
    const address = stellarStrkeyToBytes32(STELLAR_TESTNET_USDC);
    const token = getCoin({ chainId: STELLAR_TESTNET_CHAIN_ID, address });
    expect(token.address).toBe(address);
    expect(token.decimals).toBe(7);
    expect(
      getCoin({ chainId: STELLAR_TESTNET_CHAIN_ID, address: `0x${address.slice(-40)}` }).name
    ).toBe("Unknown");
    expect(getCoin({ chainId: 84532, name: "usdc" }).decimals).toBe(6);
  });
});
