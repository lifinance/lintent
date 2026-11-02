import { describe, expect, it } from "bun:test";
import { StrKey, scValToNative } from "@stellar/stellar-sdk";
import { COIN_FILLER, STELLAR_MAINNET_CHAIN_ID } from "@lifi/intent";
import { bytesToHex, decodeFunctionData } from "viem";
import { AXELAR_ORACLE_ABI, LEGACY_AXELAR_ORACLE_ABI } from "../../src/lib/abi/axelaroracle";
import {
  AXELAR_NETWORKS,
  STELLAR_TESTNET_ID,
  axelarCorridor,
  findAxelarCorridor,
  stellarContractHex
} from "../../src/lib/axelarNetworks";
import {
  axelarSubmitRoute,
  evmAxelarSubmitData,
  stellarAxelarSubmitArgs,
  type AxelarSubmitRoute
} from "../../src/lib/libraries/axelarSubmit";
import {
  buildAxelarGasRequest,
  parseAxelarGasResponse
} from "../../src/lib/libraries/axelarEstimate";

const STELLAR_MAINNET_ID = Number(STELLAR_MAINNET_CHAIN_ID);
const { mainnet, testnet } = AXELAR_NETWORKS;
const payload = `0x${"ab".repeat(72)}` as const;
const payer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));

describe("Axelar corridor lookup", () => {
  it("resolves each supported corridor to its network generation", () => {
    expect(axelarCorridor(STELLAR_MAINNET_ID, 8453).network.generation).toBe("legacy");
    expect(axelarCorridor(42161, STELLAR_MAINNET_ID).network.generation).toBe("legacy");
    expect(axelarCorridor(84532, STELLAR_TESTNET_ID).network.generation).toBe("current");
  });
  it("rejects pairs that cross networks or have no Stellar side", () => {
    for (const [a, b] of [
      [STELLAR_MAINNET_ID, 84532],
      [STELLAR_TESTNET_ID, 8453],
      [8453, 42161],
      [STELLAR_MAINNET_ID, STELLAR_TESTNET_ID],
      [STELLAR_MAINNET_ID, STELLAR_MAINNET_ID]
    ]) {
      expect(findAxelarCorridor(a, b)).toBeUndefined();
      expect(() => axelarCorridor(a, b)).toThrow("Unsupported Axelar corridor");
    }
  });
});

describe("Axelar estimator response", () => {
  it("accepts the live echo, which adds showDetailedFees to the request params", () => {
    const request = buildAxelarGasRequest(STELLAR_TESTNET_ID, 84532, [payload]);
    const response = (params: Record<string, unknown>) => ({
      baseFee: "100",
      executionFeeWithMultiplier: "900",
      totalFee: "1000",
      details: [
        {
          gasLimit: request.gasLimit,
          executeData: request.executeData,
          totalFee: "1000",
          apiResponse: {
            method: "getFees",
            params,
            result: {
              source_token: {
                contract_address: "0x0000000000000000000000000000000000000000",
                decimals: 7
              }
            }
          }
        }
      ]
    });
    expect(
      parseAxelarGasResponse(response({ ...request, showDetailedFees: true }), request, 7)
    ).toBe(1000n);
    expect(() =>
      parseAxelarGasResponse(
        response({ ...request, destinationChain: "base", showDetailedFees: true }),
        request,
        7
      )
    ).toThrow("differs");
  });
});

describe("EVM Axelar submit encoding", () => {
  it("legacy: destination name and the raw bytes32 Stellar oracle id", () => {
    const oracle = stellarContractHex(mainnet.stellar.oracle);
    const route = axelarSubmitRoute(8453, STELLAR_MAINNET_ID, oracle);
    const data = evmAxelarSubmitData(route, COIN_FILLER, [payload]);
    expect(data.slice(0, 10)).toBe("0x4fe6b72a");
    const { args } = decodeFunctionData({ abi: LEGACY_AXELAR_ORACLE_ABI, data });
    expect(args).toEqual(["stellar", oracle, COIN_FILLER, [payload], `0x${"00".repeat(32)}`, 0]);
  });
  it("current: destination name and the Stellar oracle C-strkey", () => {
    const route = axelarSubmitRoute(
      84532,
      STELLAR_TESTNET_ID,
      stellarContractHex(testnet.stellar.oracle)
    );
    const data = evmAxelarSubmitData(route, COIN_FILLER, [payload]);
    expect(data.slice(0, 10)).toBe("0xd5434caa");
    const { args } = decodeFunctionData({ abi: AXELAR_ORACLE_ABI, data });
    expect(args.slice(0, 2)).toEqual(["stellar-2026-q1-2", testnet.stellar.oracle]);
    expect(args.slice(4)).toEqual([`0x${"00".repeat(32)}`, 0]);
  });
});

describe("Stellar Axelar submit arguments", () => {
  const submit = (route: AxelarSubmitRoute) =>
    stellarAxelarSubmitArgs(route, {
      source: testnet.stellar.outputSettler,
      payer,
      payloads: [payload],
      gasAmount: 5n
    }).map((value) => scValToNative(value));
  it("legacy: destination name and the left-padded EVM oracle as BytesN<32>", () => {
    const evm = mainnet.evm[8453]!.oracle;
    const args = submit(axelarSubmitRoute(STELLAR_MAINNET_ID, 8453, evm));
    expect(args[0]).toBe("base");
    expect(bytesToHex(args[1])).toBe(`0x${"00".repeat(12)}${evm.slice(2).toLowerCase()}`);
    expect(args.slice(2, 6)).toEqual([
      testnet.stellar.outputSettler,
      [Buffer.from(payload.slice(2), "hex")],
      payer,
      5n
    ]);
    expect(bytesToHex(args[6])).toBe(`0x${"00".repeat(32)}`);
    expect(args[7]).toEqual(["Relayed"]);
    expect(() =>
      submit(axelarSubmitRoute(STELLAR_MAINNET_ID, 8453, `0x${"11".repeat(32)}`))
    ).toThrow("left-padded");
  });
  it("current: numeric destination id and the EVM oracle address string", () => {
    const evm = testnet.evm[84532]!.oracle;
    const args = submit(axelarSubmitRoute(STELLAR_TESTNET_ID, 84532, evm));
    expect(args.slice(0, 2)).toEqual([84532n, evm]);
    expect(args[7]).toEqual(["Relayed"]);
  });
});
