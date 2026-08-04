import { describe, expect, it } from "bun:test";
import { decodeEventLog } from "viem";
import type { MandateOutput } from "@lifi/intent";
import { addressToBytes32 } from "@lifi/intent";
import { decodeOutputFilledFromTronLogs, OUTPUT_FILLED_TOPIC } from "../../src/lib/tron/reads";
import type { TronTxInfo } from "../../src/lib/tron/types";
import fixture from "../fixtures/tron/txinfo-fill-old-settler.json";

// The fixture is a REAL mainnet fill captured from TronGrid
// (tests/fixtures/tron/PREFLIGHT.md) — unprefixed topics/data, unprefixed
// 20-byte log address, receipt.result SUCCESS, no top-level result key.
const txInfo = fixture as unknown as TronTxInfo;
const fixtureLog = txInfo.log![0];

const OUTPUT_FILLED_EVENT_ABI = [
  {
    type: "event",
    name: "OutputFilled",
    inputs: [
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "solver", type: "bytes32", indexed: false },
      { name: "timestamp", type: "uint32", indexed: false },
      {
        name: "output",
        type: "tuple",
        indexed: false,
        components: [
          { name: "oracle", type: "bytes32" },
          { name: "settler", type: "bytes32" },
          { name: "chainId", type: "uint256" },
          { name: "token", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "recipient", type: "bytes32" },
          { name: "callbackData", type: "bytes" },
          { name: "context", type: "bytes" }
        ]
      },
      { name: "finalAmount", type: "uint256", indexed: false }
    ]
  }
] as const;

// Ground truth extracted directly from the raw fixture log.
const direct = decodeEventLog({
  abi: OUTPUT_FILLED_EVENT_ABI,
  data: `0x${fixtureLog.data}` as `0x${string}`,
  topics: fixtureLog.topics.map((t) => `0x${t}`) as [`0x${string}`, ...`0x${string}`[]]
});
const expectedOutput = direct.args.output as MandateOutput;
const expectedOrderId = `0x${fixtureLog.topics[1]}` as `0x${string}`;
const emitterBytes32 = addressToBytes32(`0x${fixtureLog.address}` as `0x${string}`);

describe("OUTPUT_FILLED_TOPIC", () => {
  it("matches the real on-chain topic0 (same signature across generations)", () => {
    expect(OUTPUT_FILLED_TOPIC.replace("0x", "")).toBe(fixtureLog.topics[0]);
  });
});

describe("decodeOutputFilledFromTronLogs", () => {
  it("decodes the real fixture and matches the direct viem decode", () => {
    const result = decodeOutputFilledFromTronLogs(txInfo, {
      emitterBytes32,
      orderId: expectedOrderId,
      output: expectedOutput
    });
    expect(result.solver).toBe(direct.args.solver);
    expect(result.timestamp).toBe(Number(direct.args.timestamp));
    expect(result.finalAmount).toBe(BigInt(direct.args.finalAmount));
  });

  it("rejects a wrong emitter", () => {
    expect(() =>
      decodeOutputFilledFromTronLogs(txInfo, {
        emitterBytes32: addressToBytes32("0x1111111111111111111111111111111111111111"),
        orderId: expectedOrderId,
        output: expectedOutput
      })
    ).toThrow("No matching OutputFilled");
  });

  it("rejects a matching output from the wrong order", () => {
    expect(() =>
      decodeOutputFilledFromTronLogs(txInfo, {
        emitterBytes32,
        orderId: `0x${"ab".repeat(32)}` as `0x${string}`,
        output: expectedOutput
      })
    ).toThrow("No matching OutputFilled");
  });

  it("rejects a mismatched output struct", () => {
    expect(() =>
      decodeOutputFilledFromTronLogs(txInfo, {
        emitterBytes32,
        orderId: expectedOrderId,
        output: { ...expectedOutput, amount: expectedOutput.amount + 1n }
      })
    ).toThrow("No matching OutputFilled");
  });

  it("throws on ambiguous duplicate matches instead of picking one", () => {
    const duplicated: TronTxInfo = { ...txInfo, log: [fixtureLog, fixtureLog] };
    expect(() =>
      decodeOutputFilledFromTronLogs(duplicated, {
        emitterBytes32,
        orderId: expectedOrderId,
        output: expectedOutput
      })
    ).toThrow("Ambiguous fill");
  });

  it("rejects failed transactions", () => {
    const failed: TronTxInfo = {
      ...txInfo,
      result: "FAILED",
      receipt: { result: "REVERT" }
    };
    expect(() =>
      decodeOutputFilledFromTronLogs(failed, {
        emitterBytes32,
        orderId: expectedOrderId,
        output: expectedOutput
      })
    ).toThrow("did not execute successfully");
  });

  it("throws on corrupted/truncated log data", () => {
    const corrupted: TronTxInfo = {
      ...txInfo,
      log: [{ ...fixtureLog, data: fixtureLog.data!.slice(0, 100) }]
    };
    expect(() =>
      decodeOutputFilledFromTronLogs(corrupted, {
        emitterBytes32,
        orderId: expectedOrderId,
        output: expectedOutput
      })
    ).toThrow();
  });

  it("ignores unrelated logs from other contracts", () => {
    const unrelated: TronTxInfo = {
      ...txInfo,
      log: [
        {
          address: "2222222222222222222222222222222222222222",
          topics: [fixtureLog.topics[0]],
          data: fixtureLog.data
        },
        fixtureLog
      ]
    };
    const result = decodeOutputFilledFromTronLogs(unrelated, {
      emitterBytes32,
      orderId: expectedOrderId,
      output: expectedOutput
    });
    expect(result.solver).toBe(direct.args.solver);
  });
});
