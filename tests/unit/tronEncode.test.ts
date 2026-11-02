import { describe, expect, it } from "bun:test";
import type { EVMOrder, MandateOutput } from "@lifi/intent";
import { addressToBytes32, BYTES32_ZERO } from "@lifi/intent";
import {
  maxResolvedAmount,
  nativeValueOfInputs,
  nativeValueOfOutputs,
  orderToTuple,
  outputToTuple,
  solveParamsToTuples,
  solverToFillerData,
  toCallValue
} from "../../src/lib/tron/encode";

const USDT_TRON = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c" as const;

function makeOutput(overrides: Partial<MandateOutput> = {}): MandateOutput {
  return {
    oracle: addressToBytes32("0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d"),
    settler: addressToBytes32("0x784d4f7b6e99b22d923ec99edbe2e11b38ceac93"),
    chainId: 728126428n,
    token: addressToBytes32(USDT_TRON),
    amount: 1_000_000n,
    recipient: addressToBytes32("0x1111111111111111111111111111111111111111"),
    callbackData: "0x",
    context: "0x",
    ...overrides
  };
}

describe("outputToTuple", () => {
  it("encodes fields positionally in deployed-ABI order", () => {
    const output = makeOutput();
    const tuple = outputToTuple(output);
    expect(tuple).toEqual([
      output.oracle,
      output.settler,
      "728126428",
      output.token,
      "1000000",
      output.recipient,
      "0x",
      "0x"
    ]);
  });
});

describe("orderToTuple", () => {
  it("converts address fields to base58 and keeps bytes32 fields raw", () => {
    const order: EVMOrder = {
      user: "0x1111111111111111111111111111111111111111",
      nonce: 7n,
      originChainId: 728126428n,
      expires: 2_000_000_000,
      fillDeadline: 1_999_999_000,
      inputOracle: "0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d",
      inputs: [[BigInt(USDT_TRON), 5n]],
      outputs: [makeOutput()]
    };
    const toBase58 = (hex: `0x${string}`) => `b58(${hex})`;
    const tuple = orderToTuple(order, toBase58);
    expect(tuple[0]).toBe("b58(0x1111111111111111111111111111111111111111)");
    expect(tuple[1]).toBe("7");
    expect(tuple[2]).toBe("728126428");
    expect(tuple[3]).toBe(2_000_000_000);
    expect(tuple[4]).toBe(1_999_999_000);
    expect(tuple[5]).toBe("b58(0x94b0c01e26aff5a6a0fd767afe0e3ca0f8b34e3d)");
    expect(tuple[6]).toEqual([[BigInt(USDT_TRON).toString(), "5"]]);
    expect(Array.isArray(tuple[7])).toBe(true);
  });
});

describe("solveParamsToTuples", () => {
  it("emits [timestamp, solver] pairs with floored timestamps", () => {
    const solver = addressToBytes32("0x2222222222222222222222222222222222222222");
    expect(solveParamsToTuples([{ timestamp: 1234.9, solver }])).toEqual([[1234, solver]]);
  });
});

describe("solverToFillerData", () => {
  it("passes through a bytes32 solver", () => {
    const solver = addressToBytes32("0x2222222222222222222222222222222222222222");
    expect(solverToFillerData(solver)).toBe(solver);
  });
  it("rejects non-bytes32 values", () => {
    expect(() => solverToFillerData("0x1234" as `0x${string}`)).toThrow("bytes32");
  });
});

describe("native value computation", () => {
  it("sums only zero-token outputs", () => {
    const outputs = [
      makeOutput({ token: BYTES32_ZERO, amount: 3n }),
      makeOutput({ amount: 5n }),
      makeOutput({ token: BYTES32_ZERO, amount: 4n })
    ];
    expect(nativeValueOfOutputs(outputs)).toBe(7n);
  });

  it("sums only zero-address inputs", () => {
    const inputs: [bigint, bigint][] = [
      [0n, 10n],
      [BigInt(USDT_TRON), 5n],
      [0n, 2n]
    ];
    expect(nativeValueOfInputs(inputs)).toBe(12n);
  });

  it("toCallValue narrows safely and rejects overflow", () => {
    expect(toCallValue(123n)).toBe(123);
    expect(() => toCallValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("MAX_SAFE_INTEGER");
  });
});

describe("maxResolvedAmount", () => {
  const start = 1_000; // u32
  const stop = 1_600;
  const slope = 5n;
  const u32 = (n: number) => n.toString(16).padStart(8, "0");
  const u256 = (n: bigint) => n.toString(16).padStart(64, "0");

  it("returns amount for empty/limit/exclusive-limit contexts", () => {
    expect(maxResolvedAmount(makeOutput({ context: "0x" }))).toBe(1_000_000n);
    expect(maxResolvedAmount(makeOutput({ context: "0x00" }))).toBe(1_000_000n);
    expect(
      maxResolvedAmount(makeOutput({ context: `0xe0${"00".repeat(36)}` as `0x${string}` }))
    ).toBe(1_000_000n);
  });

  it("adds slope * duration for dutch auctions", () => {
    const context = `0x01${u32(start)}${u32(stop)}${u256(slope)}` as `0x${string}`;
    expect(maxResolvedAmount(makeOutput({ context }))).toBe(1_000_000n + 5n * 600n);
  });

  it("adds slope * duration for exclusive dutch auctions", () => {
    const context =
      `0xe1${"00".repeat(32)}${u32(start)}${u32(stop)}${u256(slope)}` as `0x${string}`;
    expect(maxResolvedAmount(makeOutput({ context }))).toBe(1_000_000n + 5n * 600n);
  });

  it("returns amount when stopTime <= startTime", () => {
    const context = `0x01${u32(stop)}${u32(start)}${u256(slope)}` as `0x${string}`;
    expect(maxResolvedAmount(makeOutput({ context }))).toBe(1_000_000n);
  });
});
