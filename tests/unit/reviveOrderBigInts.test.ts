import { describe, expect, test } from "bun:test";
import type { MultichainOrder, StandardOrder } from "@lifi/intent";
import { reviveOrderBigInts } from "../../src/lib/utils/intent";

// Both ingestion paths that motivated the reviver deliver orders as parsed
// JSON: the local DB round-trip (BigInt.prototype.toJSON → JSON.parse) and the
// order-server websocket push. In both, every bigint-typed field is a decimal
// string at runtime.
const parsedStandard = {
  user: "0x1111111111111111111111111111111111111111111111111111111111111111",
  nonce: "42",
  originChainId: "1151111081099710",
  expires: 1755600000,
  fillDeadline: 1755600000,
  inputOracle: "0x2222222222222222222222222222222222222222222222222222222222222222",
  inputs: [["123456789", "1496250"]],
  outputs: [
    {
      oracle: "0x3333333333333333333333333333333333333333333333333333333333333333",
      settler: "0x4444444444444444444444444444444444444444444444444444444444444444",
      chainId: "8453",
      token: "0x5555555555555555555555555555555555555555555555555555555555555555",
      amount: "1496250",
      recipient: "0x6666666666666666666666666666666666666666666666666666666666666666",
      callbackData: "0x",
      context: "0x"
    }
  ]
} as unknown as StandardOrder;

describe("reviveOrderBigInts", () => {
  test("restores bigints on a JSON round-tripped standard order", () => {
    const order = reviveOrderBigInts(parsedStandard) as StandardOrder;
    expect(order.nonce).toBe(42n);
    expect(order.originChainId).toBe(1151111081099710n);
    expect(order.inputs[0]).toEqual([123456789n, 1496250n]);
    expect(order.outputs[0]!.chainId).toBe(8453n);
    expect(order.outputs[0]!.amount).toBe(1496250n);
    // Untouched fields survive: number timestamps and hex strings.
    expect(order.expires).toBe(1755600000);
    expect(order.outputs[0]!.oracle).toBe(parsedStandard.outputs[0]!.oracle);
  });

  test("is a no-op on an order that is already bigint-typed", () => {
    const revived = reviveOrderBigInts(parsedStandard);
    expect(reviveOrderBigInts(revived)).toEqual(revived);
  });

  test("restores the nested inputs of a multichain order", () => {
    const parsedMultichain = {
      user: parsedStandard.user,
      nonce: "7",
      expires: 1755600000,
      fillDeadline: 1755600000,
      inputOracle: parsedStandard.inputOracle,
      inputs: [{ chainId: "8453", inputs: [["1", "2"]] }],
      outputs: parsedStandard.outputs
    } as unknown as MultichainOrder;
    const order = reviveOrderBigInts(parsedMultichain) as MultichainOrder;
    expect(order.nonce).toBe(7n);
    expect(order.inputs[0]!.chainId).toBe(8453n);
    expect(order.inputs[0]!.inputs[0]).toEqual([1n, 2n]);
    expect(order.outputs[0]!.chainId).toBe(8453n);
  });
});
