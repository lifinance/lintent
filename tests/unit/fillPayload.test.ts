import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { keccak256, pad, size, slice } from "viem";
import type { MandateOutput } from "@lifi/intent";
import {
  FILL_DESCRIPTION_MIN_LENGTH,
  FILL_MAGIC,
  NOT_FILLED_DESCRIPTION_MIN_LENGTH,
  NOT_FILLED_MAGIC,
  encodeFillDescription,
  encodeNotFilledDescription,
  hashFillDescription,
  hashNotFilledDescription
} from "../../src/lib/libraries/fillPayload";

/**
 * These payloads ARE the proof: `OutputSettlerBase._isPayloadValid` compares the
 * keccak256 of exactly these bytes, and the settler's input side gates finalise on
 * `isProven(..., thatHash)`. A one-byte drift does not throw anywhere — it silently
 * makes every proof check return false. `@lifi/intent@0.2.1` has exactly that drift
 * (no 4-byte magic), which is why this app owns the format and why these tests exist.
 */

const SOLVER = pad("0x1111111111111111111111111111111111111111", { size: 32 });
const ORDER_ID = keccak256("0x01");
const TOKEN = pad("0x833589fcd6EDb6E08f4c7C32D4f71b54bdA02913", { size: 32 });
const RECIPIENT = pad("0x2222222222222222222222222222222222222222", { size: 32 });

function output(overrides: Partial<MandateOutput> = {}): MandateOutput {
  return {
    // oracle / settler / chainId are part of the MandateOutput identity hash but
    // deliberately absent from both proof payloads — they must not leak in.
    oracle: pad("0x3333333333333333333333333333333333333333", { size: 32 }),
    settler: pad("0x75220B7600c300005038432a0000f308e0000068", { size: 32 }),
    chainId: 8453n,
    token: TOKEN,
    amount: 123456789000000000000n,
    recipient: RECIPIENT,
    callbackData: "0x",
    context: "0x",
    ...overrides
  } as MandateOutput;
}

const fill = (o: MandateOutput) =>
  encodeFillDescription({ solver: SOLVER, orderId: ORDER_ID, timestamp: 1700000000, output: o });
const notFilled = (o: MandateOutput) =>
  encodeNotFilledDescription({ orderId: ORDER_ID, fillDeadline: 1700000600, output: o });

describe("fill payload domain magics", () => {
  it("pins the magics to bytes4(keccak256(...)) of the domain strings", () => {
    expect(slice(keccak256(Buffer.from("OIF.Fill")), 0, 4)).toBe(FILL_MAGIC);
    expect(slice(keccak256(Buffer.from("OIF.NotFilled")), 0, 4)).toBe(NOT_FILLED_MAGIC);
    expect(FILL_MAGIC).not.toBe(NOT_FILLED_MAGIC);
  });

  it("leads every payload with its own magic so the domains cannot be cross-consumed", () => {
    expect(slice(fill(output()), 0, 4)).toBe(FILL_MAGIC);
    expect(slice(notFilled(output()), 0, 4)).toBe(NOT_FILLED_MAGIC);
  });
});

describe("encodeFillDescription", () => {
  it("encodes empty callbackData and context at the minimum length", () => {
    const payload = fill(output());
    expect(size(payload)).toBe(FILL_DESCRIPTION_MIN_LENGTH);
    // magic(4) + solver(32) + orderId(32) + timestamp(4) = 72 before the common payload
    expect(slice(payload, 4, 36)).toBe(SOLVER);
    expect(slice(payload, 36, 68)).toBe(ORDER_ID);
    expect(slice(payload, 68, 72)).toBe("0x6553f100");
    expect(slice(payload, 72, 104)).toBe(TOKEN);
    expect(slice(payload, 136, 168)).toBe(RECIPIENT);
    // Both zero-length prefixes, back to back.
    expect(slice(payload, 168, 172)).toBe("0x00000000");
  });

  it("length-prefixes a non-empty callbackData with an empty context", () => {
    const payload = fill(output({ callbackData: "0xdeadbeef" }));
    expect(size(payload)).toBe(FILL_DESCRIPTION_MIN_LENGTH + 4);
    expect(slice(payload, 168, 170)).toBe("0x0004");
    expect(slice(payload, 170, 174)).toBe("0xdeadbeef");
    expect(slice(payload, 174, 176)).toBe("0x0000");
  });

  it("length-prefixes a non-empty context with an empty callbackData", () => {
    const payload = fill(output({ context: "0x01020304050607" }));
    expect(size(payload)).toBe(FILL_DESCRIPTION_MIN_LENGTH + 7);
    expect(slice(payload, 168, 170)).toBe("0x0000");
    expect(slice(payload, 170, 172)).toBe("0x0007");
    expect(slice(payload, 172, 179)).toBe("0x01020304050607");
  });

  it("keeps the two variable fields distinguishable when both are non-empty", () => {
    const payload = fill(output({ callbackData: "0xdeadbeef", context: "0x01020304050607" }));
    expect(size(payload)).toBe(FILL_DESCRIPTION_MIN_LENGTH + 4 + 7);
    expect(slice(payload, 168, 176)).toBe("0x0004deadbeef0007");
    expect(slice(payload, 176, 183)).toBe("0x01020304050607");
    // Swapping the two fields must not collide: the length prefixes are what
    // makes the encoding injective.
    const swapped = fill(output({ callbackData: "0x01020304050607", context: "0xdeadbeef" }));
    expect(swapped).not.toBe(payload);
  });

  it("handles a callbackData longer than 32 bytes (multi-word length prefix path)", () => {
    const callbackData = `0x${"ab".repeat(70)}` as const;
    const payload = fill(output({ callbackData, context: "0xbeef" }));
    expect(size(payload)).toBe(FILL_DESCRIPTION_MIN_LENGTH + 70 + 2);
    expect(slice(payload, 168, 170)).toBe("0x0046"); // 70
    expect(slice(payload, 170, 240)).toBe(callbackData);
    expect(slice(payload, 240, 242)).toBe("0x0002");
    expect(slice(payload, 242, 244)).toBe("0xbeef");
  });

  it("rejects a callbackData that overflows the uint16 length prefix", () => {
    const tooLong = `0x${"00".repeat(65536)}` as `0x${string}`;
    expect(() => fill(output({ callbackData: tooLong }))).toThrow(/uint16 length prefix/);
    expect(() => fill(output({ context: tooLong }))).toThrow(/uint16 length prefix/);
  });

  it("rejects a timestamp outside uint32", () => {
    expect(() =>
      encodeFillDescription({
        solver: SOLVER,
        orderId: ORDER_ID,
        timestamp: 2 ** 32,
        output: output()
      })
    ).toThrow(/uint32/);
  });
});

describe("encodeNotFilledDescription", () => {
  it("encodes empty callbackData and context at the minimum length", () => {
    const payload = notFilled(output());
    expect(size(payload)).toBe(NOT_FILLED_DESCRIPTION_MIN_LENGTH);
    // magic(4) + orderId(32) + fillDeadline(4) = 40 before the common payload
    expect(slice(payload, 4, 36)).toBe(ORDER_ID);
    expect(slice(payload, 36, 40)).toBe("0x6553f358");
    expect(slice(payload, 40, 72)).toBe(TOKEN);
    expect(slice(payload, 104, 136)).toBe(RECIPIENT);
    // Both zero-length prefixes, back to back.
    expect(slice(payload, 136, 140)).toBe("0x00000000");
  });

  it("length-prefixes both variable fields", () => {
    const payload = notFilled(output({ callbackData: "0xdeadbeef", context: "0x01020304050607" }));
    expect(size(payload)).toBe(NOT_FILLED_DESCRIPTION_MIN_LENGTH + 4 + 7);
    expect(slice(payload, 136, 144)).toBe("0x0004deadbeef0007");
    expect(slice(payload, 144, 151)).toBe("0x01020304050607");
  });

  it("never collides with a FillDescription over the same common payload", () => {
    // A NotFilledDescription is 32 bytes shorter (no solver) but the magics are
    // the guarantee, not the length.
    const o = output({ callbackData: "0xdeadbeef" });
    expect(slice(fill(o), 0, 4)).not.toBe(slice(notFilled(o), 0, 4));
  });
});

/**
 * Golden vectors generated from Solidity by
 * `lifi-oif/test/util/GenerateFillPayloadVectors.t.sol`. The copy under
 * `tests/fixtures/` is what CI checks against so this suite does not depend on a
 * sibling checkout; the drift guard below fails loudly if the contracts repo has
 * regenerated newer vectors than the vendored copy.
 */
const VENDORED_VECTORS = new URL("../fixtures/fillPayloadVectors.json", import.meta.url).pathname;
const CONTRACTS_VECTORS =
  process.env.FILL_PAYLOAD_VECTORS ??
  new URL("../../../lifi-oif/test/util/vectors/fillPayloadVectors.json", import.meta.url).pathname;

type Vector = {
  name: string;
  kind: "fill" | "notFilled";
  magic: `0x${string}`;
  solver?: `0x${string}`;
  orderId: `0x${string}`;
  timestamp?: number;
  fillDeadline?: number;
  token: `0x${string}`;
  amount: string;
  recipient: `0x${string}`;
  callbackData: `0x${string}`;
  context: `0x${string}`;
  payload: `0x${string}`;
  payloadLength: number;
  payloadHash: `0x${string}`;
};

type VectorFile = {
  fillMagic: `0x${string}`;
  notFilledMagic: `0x${string}`;
  vectors: Vector[];
};

function loadVectors(path: string): VectorFile {
  if (!existsSync(path)) {
    throw new Error(
      `Golden fill-payload vectors not found at ${path}. Generate them in lifi-oif ` +
        `(forge test --mc GenerateFillPayloadVectors) and copy the result to ` +
        `tests/fixtures/fillPayloadVectors.json, or point FILL_PAYLOAD_VECTORS at the file.`
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as VectorFile;
}

describe("golden vectors from Solidity", () => {
  const file = loadVectors(VENDORED_VECTORS);

  it("has vectors covering both payload domains", () => {
    expect(file.vectors.length).toBeGreaterThan(0);
    expect(file.vectors.some((v) => v.kind === "fill")).toBe(true);
    expect(file.vectors.some((v) => v.kind === "notFilled")).toBe(true);
    // Solidity serialises bytes4 right-padded to a word; compare the leading 4 bytes.
    expect(slice(file.fillMagic, 0, 4)).toBe(FILL_MAGIC);
    expect(slice(file.notFilledMagic, 0, 4)).toBe(NOT_FILLED_MAGIC);
  });

  for (const vector of loadVectors(VENDORED_VECTORS).vectors) {
    it(`reproduces ${vector.kind} vector "${vector.name}" byte-for-byte`, () => {
      const o = output({
        token: vector.token,
        amount: BigInt(vector.amount),
        recipient: vector.recipient,
        callbackData: vector.callbackData,
        context: vector.context
      });

      let payload: `0x${string}`;
      let hash: `0x${string}`;
      if (vector.kind === "fill") {
        const args = {
          solver: vector.solver!,
          orderId: vector.orderId,
          timestamp: vector.timestamp!,
          output: o
        };
        payload = encodeFillDescription(args);
        hash = hashFillDescription(args);
      } else {
        const args = {
          orderId: vector.orderId,
          fillDeadline: vector.fillDeadline!,
          output: o
        };
        payload = encodeNotFilledDescription(args);
        hash = hashNotFilledDescription(args);
      }

      expect(payload).toBe(vector.payload);
      expect(size(payload)).toBe(vector.payloadLength);
      expect(hash).toBe(vector.payloadHash);
      expect(slice(payload, 0, 4)).toBe(slice(vector.magic, 0, 4));
    });
  }

  it("vendored vectors match the contracts repo when it is checked out alongside", () => {
    if (!existsSync(CONTRACTS_VECTORS)) {
      // Nothing to compare against in CI — the vendored copy above is authoritative there.
      return;
    }
    // Compared as parsed JSON, not raw bytes: the vendored copy goes through
    // prettier, so whitespace legitimately differs while the vectors must not.
    expect(loadVectors(VENDORED_VECTORS)).toEqual(loadVectors(CONTRACTS_VECTORS));
  });
});
