// Solana event decoding.
//
// The programs emit with Anchor's `emit!`, which compiles to `sol_log_data`:
// one `Program data: <base64>` line carrying `discriminator(8) || borsh(event)`.
// There is no self-CPI and no event-authority PDA, so the ONLY thing tying a
// log line to a program is the invoke frame it appears in — any program can
// print a `Program data:` line, including one crafted to look like a fill.
// Frame attribution is therefore the anti-spoof, not a nicety.
//
// None of the events below appear in the generated IDLs: they are defined in
// the helper crates (output_settler_base, input_settler_base, oracle_base)
// rather than inside a `#[program]` module, so `anchor build` omits them and
// `output_settler_simple.json` ships `"events": []`. The layouts here are
// hand-rolled against the Rust structs and pinned by tests.

import { getOutputHash } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { bytesToHex } from "viem";

/** `sha256("event:<Name>")[..8]`, pinned so a rename cannot silently pass. */
export const OUTPUT_FILLED_DISCRIMINATOR = new Uint8Array([43, 25, 133, 52, 107, 176, 40, 213]);
export const OUTPUT_NOT_FILLED_DISCRIMINATOR = new Uint8Array([
  162, 22, 108, 52, 116, 186, 115, 37
]);
export const OPEN_DISCRIMINATOR = new Uint8Array([13, 191, 79, 145, 65, 183, 42, 90]);
export const FINALISED_DISCRIMINATOR = new Uint8Array([226, 131, 196, 252, 105, 222, 23, 210]);
export const OUTPUT_PROVEN_DISCRIMINATOR = new Uint8Array([85, 190, 185, 8, 90, 48, 3, 214]);

const PROGRAM_DATA_PREFIX = "Program data: ";
const PROGRAM_LOG_PREFIX = "Program log: ";

export type DecodedSolanaFill = {
  settler: `0x${string}`;
  orderId: `0x${string}`;
  solver: `0x${string}`;
  timestamp: number;
  output: MandateOutput;
  finalAmount: bigint;
};

/** Minimal sequential borsh reader; throws rather than reading past the end. */
class BorshReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  private take(length: number): Uint8Array {
    // A negative length would pass the upper-bound check below, return an
    // empty slice, and move the offset BACKWARDS — re-reading earlier bytes
    // instead of failing. Only a malformed payload can produce one.
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`Invalid read length ${length} at offset ${this.offset}`);
    }
    if (this.offset + length > this.data.length) {
      throw new Error(
        `Truncated event payload: wanted ${length} bytes at offset ${this.offset}, have ${this.data.length}`
      );
    }
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  bytes32(): `0x${string}` {
    return bytesToHex(this.take(32));
  }

  u32(): number {
    const b = this.take(4);
    // The unsigned coercion must wrap the WHOLE expression: `|` re-coerces its
    // operands to signed int32, so an inner `>>> 0` on the high byte alone is
    // defeated and bit 31 would come back as a negative number.
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  u64(): bigint {
    const b = this.take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(b[i]!);
    return value;
  }

  /** A borsh `Vec<u8>`: u32 little-endian length, then that many bytes. */
  vecU8(): `0x${string}` {
    return bytesToHex(this.take(this.u32()));
  }

  get consumed(): number {
    return this.offset;
  }

  get length(): number {
    return this.data.length;
  }
}

function startsWithDiscriminator(data: Uint8Array, discriminator: Uint8Array): boolean {
  if (data.length < discriminator.length) return false;
  return discriminator.every((byte, i) => data[i] === byte);
}

/**
 * Decodes an `OutputFilledEvent` payload (discriminator already matched).
 *
 * Rust layout (output_settler_base/src/events.rs):
 *   settler: Pubkey(32), order_id: [u8;32], solver: [u8;32], timestamp: u32 LE,
 *   output: MandateOutput, final_amount: u64 LE
 * where MandateOutput is six [u8;32] fields followed by two borsh `Vec<u8>`.
 *
 * `chainId` and `amount` are [u8;32] big-endian on the wire but bigint in the
 * MandateOutput type, so they are widened here.
 */
export function decodeOutputFilledEvent(payload: Uint8Array): DecodedSolanaFill {
  const reader = new BorshReader(payload.subarray(OUTPUT_FILLED_DISCRIMINATOR.length));

  const settler = reader.bytes32();
  const orderId = reader.bytes32();
  const solver = reader.bytes32();
  const timestamp = reader.u32();

  const output: MandateOutput = {
    oracle: reader.bytes32(),
    settler: reader.bytes32(),
    chainId: BigInt(reader.bytes32()),
    token: reader.bytes32(),
    amount: BigInt(reader.bytes32()),
    recipient: reader.bytes32(),
    callbackData: reader.vecU8(),
    context: reader.vecU8()
  } as MandateOutput;

  const finalAmount = reader.u64();

  // A payload that decodes but leaves bytes over is not the event we think it
  // is — treat it as a mismatch rather than trusting a prefix parse.
  if (reader.consumed !== reader.length) {
    throw new Error(
      `OutputFilledEvent has ${reader.length - reader.consumed} trailing bytes; layout mismatch`
    );
  }

  return { settler, orderId, solver, timestamp, output, finalAmount };
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Every `Program data:` line emitted inside a top-level invocation of
 * `programId`, in order.
 *
 * Solana logs are a flat list with `Program <id> invoke [depth]` /
 * `Program <id> success|failed` bracketing each frame, so the depth has to be
 * tracked to know which program actually printed a line. Lines emitted by a
 * CPI *into* another program belong to that program's frame, not ours.
 */
export function programDataLogs(logs: readonly string[], programId: string): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  const stack: string[] = [];

  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack[stack.length - 1] !== programId) continue;

    const raw = line.startsWith(PROGRAM_DATA_PREFIX)
      ? line.slice(PROGRAM_DATA_PREFIX.length)
      : undefined;
    if (raw === undefined) continue;

    const decoded = decodeBase64(raw.trim());
    if (decoded) payloads.push(decoded);
  }

  return payloads;
}

/** The `Prove:` lines `oracle_polymer::submit` writes with `msg!`. */
export function findProveLogs(logs: readonly string[], polymerProgramId: string): string[] {
  const marker = `Prove: program: ${polymerProgramId},`;
  return logs
    .map((line) =>
      line.startsWith(PROGRAM_LOG_PREFIX) ? line.slice(PROGRAM_LOG_PREFIX.length) : line
    )
    .filter((line) => line.startsWith(marker));
}

/**
 * Finds and decodes THE OutputFilled event matching the expected order and
 * output. Strict by design, mirroring `decodeOutputFilledFromTronLogs`:
 * - only `Program data:` lines emitted inside the output settler's own invoke
 *   frame are considered (any program can print one),
 * - the 8-byte discriminator must match,
 * - the event's orderId and the output's struct hash must both match,
 * - zero matches is an error, and so is more than one — never silently pick
 *   the first, because two fills of the same output cannot both be the one
 *   being settled,
 * - a zero solver or an out-of-range timestamp is an error.
 */
export function findOutputFilledLog(
  logs: readonly string[],
  expected: {
    programId: string;
    orderId: `0x${string}`;
    output: MandateOutput;
  }
): DecodedSolanaFill {
  const expectedOrderId = expected.orderId.toLowerCase();
  const expectedHash = getOutputHash(expected.output).toLowerCase();

  const matches: DecodedSolanaFill[] = [];
  for (const payload of programDataLogs(logs, expected.programId)) {
    if (!startsWithDiscriminator(payload, OUTPUT_FILLED_DISCRIMINATOR)) continue;

    let decoded: DecodedSolanaFill;
    try {
      decoded = decodeOutputFilledEvent(payload);
    } catch {
      // A truncated or mislaid payload is not a match. It must not abort the
      // scan: a later line in the same transaction may be the real event.
      continue;
    }

    if (decoded.orderId.toLowerCase() !== expectedOrderId) continue;
    if (getOutputHash(decoded.output).toLowerCase() !== expectedHash) continue;

    if (BigInt(decoded.solver) === 0n) {
      throw new Error("OutputFilledEvent has a zero solver");
    }
    if (!Number.isInteger(decoded.timestamp) || decoded.timestamp < 0) {
      throw new Error(`OutputFilledEvent timestamp out of range: ${decoded.timestamp}`);
    }
    matches.push(decoded);
  }

  if (matches.length === 0) {
    throw new Error("No matching OutputFilled event found in Solana transaction");
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous fill: ${matches.length} OutputFilled events match the same order and output`
    );
  }
  return matches[0]!;
}
