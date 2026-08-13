import { describe, expect, test } from "bun:test";
import type { MandateOutput } from "@lifi/intent";
import { concat, hexToBytes, numberToHex, sha256, stringToBytes, toBytes } from "viem";
import {
  FINALISED_DISCRIMINATOR,
  OPEN_DISCRIMINATOR,
  OUTPUT_FILLED_DISCRIMINATOR,
  OUTPUT_NOT_FILLED_DISCRIMINATOR,
  OUTPUT_PROVEN_DISCRIMINATOR,
  decodeOutputFilledEvent,
  findOutputFilledLog,
  findProveLogs,
  programDataLogs
} from "../../src/lib/solana/events";

const SETTLER_PROGRAM = "LiFiEDFjz5x1jJe9gSXNDHQW4dWt4yLXdp2VN4EiQUt";
const POLYMER_PROGRAM = "LiFiBtfyPT1DnTHTAeZ2rwr5RgMrThwA5kt7KGT5nBV";
const OTHER_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const b32 = (nibble: string) => `0x${nibble.repeat(64)}` as `0x${string}`;

const ORDER_ID = b32("6");
const SOLVER = b32("5");

function makeOutput(overrides: Partial<MandateOutput> = {}): MandateOutput {
  return {
    oracle: b32("1"),
    settler: b32("2"),
    chainId: 1151111081099712n,
    token: b32("3"),
    amount: 1_000_000n,
    recipient: b32("4"),
    callbackData: "0x",
    context: "0x",
    ...overrides
  } as MandateOutput;
}

function u32le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff
  ]);
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Builds the exact bytes the on-chain `emit!(OutputFilledEvent{..})` produces. */
function encodeOutputFilledEvent(args: {
  settler?: `0x${string}`;
  orderId?: `0x${string}`;
  solver?: `0x${string}`;
  timestamp?: number;
  output?: MandateOutput;
  finalAmount?: bigint;
}): string {
  const output = args.output ?? makeOutput();
  const callbackData = toBytes(output.callbackData);
  const context = toBytes(output.context);
  const bytes = concat([
    OUTPUT_FILLED_DISCRIMINATOR,
    hexToBytes(args.settler ?? b32("2")),
    hexToBytes(args.orderId ?? ORDER_ID),
    hexToBytes(args.solver ?? SOLVER),
    u32le(args.timestamp ?? 1_700_000_000),
    hexToBytes(output.oracle),
    hexToBytes(output.settler),
    hexToBytes(numberToHex(output.chainId, { size: 32 })),
    hexToBytes(output.token),
    hexToBytes(numberToHex(output.amount, { size: 32 })),
    hexToBytes(output.recipient),
    u32le(callbackData.length),
    callbackData,
    u32le(context.length),
    context,
    u64le(args.finalAmount ?? 1_000_000n)
  ]);
  return Buffer.from(bytes).toString("base64");
}

function fillLogs(payloadBase64: string, programId = SETTLER_PROGRAM): string[] {
  return [
    `Program ${programId} invoke [1]`,
    `Program data: ${payloadBase64}`,
    `Program ${programId} success`
  ];
}

describe("event discriminators", () => {
  test.each([
    ["OutputFilledEvent", OUTPUT_FILLED_DISCRIMINATOR],
    ["OutputNotFilledEvent", OUTPUT_NOT_FILLED_DISCRIMINATOR],
    ["OpenEvent", OPEN_DISCRIMINATOR],
    ["FinalisedEvent", FINALISED_DISCRIMINATOR],
    ["OutputProvenEvent", OUTPUT_PROVEN_DISCRIMINATOR]
  ])("%s equals sha256('event:<Name>')[..8]", (name, discriminator) => {
    // These events are absent from the generated IDLs, so nothing else pins
    // them. If Anchor's scheme or an event name ever changes, this fails
    // rather than the decoder silently matching nothing.
    const expected = hexToBytes(sha256(stringToBytes(`event:${name}`))).slice(0, 8);
    expect(Array.from(discriminator)).toEqual(Array.from(expected));
  });
});

describe("decodeOutputFilledEvent", () => {
  test("round-trips a full event including callbackData and context", () => {
    const output = makeOutput({ callbackData: "0xdeadbeef", context: "0xc0ffee" });
    const decoded = decodeOutputFilledEvent(
      toBytes(`0x${Buffer.from(encodeOutputFilledEvent({ output }), "base64").toString("hex")}`)
    );
    expect(decoded.orderId).toBe(ORDER_ID);
    expect(decoded.solver).toBe(SOLVER);
    expect(decoded.timestamp).toBe(1_700_000_000);
    expect(decoded.output.callbackData).toBe("0xdeadbeef");
    expect(decoded.output.context).toBe("0xc0ffee");
    expect(decoded.output.chainId).toBe(output.chainId);
    expect(decoded.output.amount).toBe(output.amount);
    expect(decoded.finalAmount).toBe(1_000_000n);
  });

  test("rejects a payload with trailing bytes", () => {
    // A prefix parse that "works" is how a layout drift goes unnoticed.
    const base = Buffer.from(encodeOutputFilledEvent({}), "base64");
    const padded = new Uint8Array(base.length + 3);
    padded.set(base);
    expect(() => decodeOutputFilledEvent(padded)).toThrow("trailing bytes");
  });

  test("rejects a truncated payload", () => {
    const base = Buffer.from(encodeOutputFilledEvent({}), "base64");
    expect(() => decodeOutputFilledEvent(base.subarray(0, base.length - 4))).toThrow("Truncated");
  });
});

describe("programDataLogs frame attribution", () => {
  test("ignores a Program data line printed by another program", () => {
    const payload = encodeOutputFilledEvent({});
    const logs = [
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program data: ${payload}`,
      `Program ${OTHER_PROGRAM} success`
    ];
    expect(programDataLogs(logs, SETTLER_PROGRAM)).toHaveLength(0);
  });

  test("attributes a line inside a CPI to the inner program, not the outer", () => {
    const payload = encodeOutputFilledEvent({});
    const logs = [
      `Program ${SETTLER_PROGRAM} invoke [1]`,
      `Program ${OTHER_PROGRAM} invoke [2]`,
      `Program data: ${payload}`,
      `Program ${OTHER_PROGRAM} success`,
      `Program ${SETTLER_PROGRAM} success`
    ];
    expect(programDataLogs(logs, SETTLER_PROGRAM)).toHaveLength(0);
    expect(programDataLogs(logs, OTHER_PROGRAM)).toHaveLength(1);
  });

  test("collects lines emitted after an inner CPI returns", () => {
    const payload = encodeOutputFilledEvent({});
    const logs = [
      `Program ${SETTLER_PROGRAM} invoke [1]`,
      `Program ${OTHER_PROGRAM} invoke [2]`,
      `Program ${OTHER_PROGRAM} success`,
      `Program data: ${payload}`,
      `Program ${SETTLER_PROGRAM} success`
    ];
    expect(programDataLogs(logs, SETTLER_PROGRAM)).toHaveLength(1);
  });
});

describe("findOutputFilledLog", () => {
  const output = makeOutput();

  test("finds the matching event", () => {
    const decoded = findOutputFilledLog(fillLogs(encodeOutputFilledEvent({ output })), {
      programId: SETTLER_PROGRAM,
      orderId: ORDER_ID,
      output
    });
    expect(decoded.solver).toBe(SOLVER);
    expect(decoded.timestamp).toBe(1_700_000_000);
  });

  test("rejects an event spoofed by an unrelated program", () => {
    // The anti-spoof: the payload is byte-identical and would decode fine, but
    // it was not printed inside the settler's frame.
    const logs = [
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program data: ${encodeOutputFilledEvent({ output })}`,
      `Program ${OTHER_PROGRAM} success`
    ];
    expect(() =>
      findOutputFilledLog(logs, { programId: SETTLER_PROGRAM, orderId: ORDER_ID, output })
    ).toThrow("No matching OutputFilled event");
  });

  test("rejects a different orderId", () => {
    const logs = fillLogs(encodeOutputFilledEvent({ orderId: b32("9"), output }));
    expect(() =>
      findOutputFilledLog(logs, { programId: SETTLER_PROGRAM, orderId: ORDER_ID, output })
    ).toThrow("No matching OutputFilled event");
  });

  test("rejects a different output", () => {
    const logs = fillLogs(encodeOutputFilledEvent({ output }));
    expect(() =>
      findOutputFilledLog(logs, {
        programId: SETTLER_PROGRAM,
        orderId: ORDER_ID,
        output: makeOutput({ amount: 999n })
      })
    ).toThrow("No matching OutputFilled event");
  });

  test("throws on two events matching the same order and output", () => {
    // Never silently pick the first: both cannot be the fill being settled.
    const payload = encodeOutputFilledEvent({ output });
    const logs = [
      `Program ${SETTLER_PROGRAM} invoke [1]`,
      `Program data: ${payload}`,
      `Program data: ${payload}`,
      `Program ${SETTLER_PROGRAM} success`
    ];
    expect(() =>
      findOutputFilledLog(logs, { programId: SETTLER_PROGRAM, orderId: ORDER_ID, output })
    ).toThrow("Ambiguous fill");
  });

  test("throws on a zero solver", () => {
    const logs = fillLogs(
      encodeOutputFilledEvent({ solver: `0x${"00".repeat(32)}` as `0x${string}`, output })
    );
    expect(() =>
      findOutputFilledLog(logs, { programId: SETTLER_PROGRAM, orderId: ORDER_ID, output })
    ).toThrow("zero solver");
  });

  test("skips an undecodable payload instead of aborting the scan", () => {
    // A malformed line must not hide a valid event later in the same tx.
    const logs = [
      `Program ${SETTLER_PROGRAM} invoke [1]`,
      `Program data: ${Buffer.from(OUTPUT_FILLED_DISCRIMINATOR).toString("base64")}`,
      `Program data: ${encodeOutputFilledEvent({ output })}`,
      `Program ${SETTLER_PROGRAM} success`
    ];
    expect(
      findOutputFilledLog(logs, { programId: SETTLER_PROGRAM, orderId: ORDER_ID, output }).solver
    ).toBe(SOLVER);
  });

  test("ignores non-OutputFilled events in the same frame", () => {
    const logs = [
      `Program ${SETTLER_PROGRAM} invoke [1]`,
      `Program data: ${Buffer.from(OPEN_DISCRIMINATOR).toString("base64")}`,
      `Program data: ${encodeOutputFilledEvent({ output })}`,
      `Program ${SETTLER_PROGRAM} success`
    ];
    expect(
      findOutputFilledLog(logs, { programId: SETTLER_PROGRAM, orderId: ORDER_ID, output }).timestamp
    ).toBe(1_700_000_000);
  });
});

describe("findProveLogs", () => {
  test("matches the msg! line oracle_polymer::submit emits", () => {
    const logs = [
      `Program ${POLYMER_PROGRAM} invoke [1]`,
      `Program log: Prove: program: ${POLYMER_PROGRAM}, AAAA`,
      `Program ${POLYMER_PROGRAM} success`
    ];
    expect(findProveLogs(logs, POLYMER_PROGRAM)).toHaveLength(1);
  });

  test("ignores a Prove line naming a different program", () => {
    const logs = [`Program log: Prove: program: ${OTHER_PROGRAM}, AAAA`];
    expect(findProveLogs(logs, POLYMER_PROGRAM)).toHaveLength(0);
  });
});
