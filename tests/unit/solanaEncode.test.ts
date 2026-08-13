import { describe, expect, test } from "bun:test";
import { BYTES32_ZERO, FILL_MAGIC, encodeFillDescription, getOutputHash } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { concat, encodePacked, keccak256, numberToHex, toHex } from "viem";
import {
  U64_MAX,
  assertSolanaAmountFitsU64,
  commonPayload,
  fillDescriptionWithoutTimestamp,
  fillPayloadHash,
  isNativeSolanaOutput,
  localAttestationDataHash,
  solverToFillerData
} from "../../src/lib/solana/encode";

const b32 = (nibble: string) => `0x${nibble.repeat(64)}` as `0x${string}`;

const SOLVER = b32("5");
const ORDER_ID = b32("6");

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

describe("commonPayload", () => {
  test("matches the Rust encode_common_payload layout byte for byte", () => {
    // token(32) | amount(32) | recipient(32) | u16be(cbLen) | cb | u16be(ctxLen) | ctx
    // Built here independently of the implementation so a change to either
    // side has to be deliberate.
    const output = makeOutput({ callbackData: "0xdeadbeef", context: "0xc0ffee" });
    const expected = concat([
      output.token,
      numberToHex(output.amount, { size: 32 }),
      output.recipient,
      numberToHex(4, { size: 2 }),
      "0xdeadbeef",
      numberToHex(3, { size: 2 }),
      "0xc0ffee"
    ]);
    expect(commonPayload(output)).toBe(expected);
  });

  test("encodes empty callbackData and context as zero lengths", () => {
    const payload = commonPayload(makeOutput());
    // 32 + 32 + 32 + 2 + 0 + 2 + 0 = 100 bytes
    expect((payload.length - 2) / 2).toBe(100);
    expect(payload.endsWith("00000000")).toBe(true);
  });
});

describe("fill descriptions", () => {
  test("the without-timestamp variant is the with-timestamp one minus 4 bytes", () => {
    // The only structural difference is the uint32 timestamp at offset 68.
    const output = makeOutput();
    const withTs = encodeFillDescription({
      solver: SOLVER,
      orderId: ORDER_ID,
      timestamp: 1_700_000_000,
      output
    });
    const withoutTs = fillDescriptionWithoutTimestamp({
      solver: SOLVER,
      orderId: ORDER_ID,
      output
    });
    expect((withTs.length - withoutTs.length) / 2).toBe(4);
    // Same prefix up to the timestamp slot (4 + 32 + 32 = 68 bytes).
    expect(withTs.slice(0, 2 + 68 * 2)).toBe(withoutTs.slice(0, 2 + 68 * 2));
    // And the same tail after it.
    expect(withTs.slice(2 + 72 * 2)).toBe(withoutTs.slice(2 + 68 * 2));
  });

  test("the without-timestamp variant leads with FILL_MAGIC", () => {
    // The magic is what keeps the fill and not-filled proof domains from being
    // cross-consumed; dropping it was the v0.3.0 bug.
    const encoded = fillDescriptionWithoutTimestamp({
      solver: SOLVER,
      orderId: ORDER_ID,
      output: makeOutput()
    });
    expect(encoded.slice(0, 10)).toBe(FILL_MAGIC);
  });

  test("matches an independently built Rust-layout encoding", () => {
    const output = makeOutput();
    const expected = encodePacked(
      ["bytes4", "bytes32", "bytes32", "bytes"],
      [FILL_MAGIC, SOLVER, ORDER_ID, commonPayload(output)]
    );
    expect(fillDescriptionWithoutTimestamp({ solver: SOLVER, orderId: ORDER_ID, output })).toBe(
      expected
    );
  });

  test("localAttestationDataHash and fillPayloadHash are different hashes", () => {
    // Conflating them derives an attestation account that does not exist —
    // the failure is silent until finalise cannot find its account.
    const output = makeOutput();
    const local = localAttestationDataHash({ solver: SOLVER, orderId: ORDER_ID, output });
    const remote = fillPayloadHash({
      solver: SOLVER,
      orderId: ORDER_ID,
      timestamp: 1_700_000_000,
      output
    });
    expect(local).not.toBe(remote);
    expect(local).toBe(
      keccak256(fillDescriptionWithoutTimestamp({ solver: SOLVER, orderId: ORDER_ID, output }))
    );
  });

  test("localAttestationDataHash is independent of the timestamp", () => {
    // This is the whole reason the variant exists: the hash is a PDA seed, so
    // it must be derivable before the fill lands.
    const output = makeOutput();
    const hash = localAttestationDataHash({ solver: SOLVER, orderId: ORDER_ID, output });
    expect(localAttestationDataHash({ solver: SOLVER, orderId: ORDER_ID, output })).toBe(hash);
  });

  test("the hashes change with solver, orderId and output", () => {
    const base = localAttestationDataHash({
      solver: SOLVER,
      orderId: ORDER_ID,
      output: makeOutput()
    });
    expect(
      localAttestationDataHash({ solver: b32("7"), orderId: ORDER_ID, output: makeOutput() })
    ).not.toBe(base);
    expect(
      localAttestationDataHash({ solver: SOLVER, orderId: b32("8"), output: makeOutput() })
    ).not.toBe(base);
    expect(
      localAttestationDataHash({
        solver: SOLVER,
        orderId: ORDER_ID,
        output: makeOutput({ amount: 2n })
      })
    ).not.toBe(base);
  });
});

describe("getOutputHash as the FillId seed", () => {
  test("hashes the oracle/settler/chainId prefix followed by the common payload", () => {
    // The Rust mandate_output_hash is
    // keccak(oracle | settler | chainId_be32 | commonPayload). Rebuilding it
    // here proves the library's getOutputHash is the same function, which is
    // why this module re-exports it instead of defining a second one.
    const output = makeOutput({ callbackData: "0xbeef", context: "0x" });
    const expected = keccak256(
      concat([
        output.oracle,
        output.settler,
        numberToHex(output.chainId, { size: 32 }),
        commonPayload(output)
      ])
    );
    expect(getOutputHash(output)).toBe(expected);
  });
});

describe("solverToFillerData", () => {
  test("returns the 32 solver bytes", () => {
    const data = solverToFillerData(SOLVER);
    expect(data).toHaveLength(32);
    expect(toHex(data)).toBe(SOLVER);
  });

  test("rejects the zero pubkey", () => {
    // resolve_output rejects it on chain; catching it here avoids a signed
    // transaction that cannot succeed.
    expect(() => solverToFillerData(BYTES32_ZERO)).toThrow("zero pubkey");
  });

  test("rejects a 20-byte EVM address", () => {
    expect(() => solverToFillerData("0x75220B7600c300005038432a0000f308e0000068")).toThrow(
      "32-byte solver identity"
    );
  });
});

describe("native outputs and u64 bounds", () => {
  test("isNativeSolanaOutput detects the zero token", () => {
    expect(isNativeSolanaOutput(makeOutput({ token: BYTES32_ZERO }))).toBe(true);
    expect(isNativeSolanaOutput(makeOutput())).toBe(false);
  });

  test("assertSolanaAmountFitsU64 accepts u64 max and rejects one above", () => {
    expect(() => assertSolanaAmountFitsU64(makeOutput({ amount: U64_MAX }))).not.toThrow();
    expect(() => assertSolanaAmountFitsU64(makeOutput({ amount: U64_MAX + 1n }))).toThrow(
      "exceeds u64"
    );
  });
});
