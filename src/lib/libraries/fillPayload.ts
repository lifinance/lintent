import { encodePacked, keccak256 } from "viem";
import type { MandateOutput } from "@lifi/intent";

/**
 * Proof-payload wire format, owned locally.
 *
 * Source of truth: `src/libs/MandateOutputEncodingLib.sol` in the OIF contracts
 * (lifi-oif). Both proof payloads lead with a distinct 4-byte domain magic so a
 * consumer dispatches on the leading 4 bytes and the two proof domains can never
 * be cross-consumed.
 *
 * `@lifi/intent`'s `encodeMandateOutput` (0.2.1, the latest published release)
 * predates the magic: it starts at `solver` and therefore produces a preimage the
 * deployed settlers reject. Every `isProven` / attestation hash in this app must
 * go through the encoders below instead. Do NOT wrap the package helper and
 * prepend bytes — the format lives here, explicitly, next to the constants.
 *
 * NOTE: this is a DIFFERENT hash from `getOutputHash` (the serialised
 * MandateOutput: `oracle‖settler‖chainId‖…`). That one is an internal identity
 * key, is never ferried cross-chain, and carries no magic. Do not conflate them.
 *
 *   FillDescription
 *     FILL_MAGIC        (4 bytes)
 *     solver            (bytes32)
 *     orderId           (bytes32)
 *     timestamp         (uint32)
 *     <common payload>
 *
 *   NotFilledDescription
 *     NOT_FILLED_MAGIC  (4 bytes)
 *     orderId           (bytes32)
 *     fillDeadline      (uint32)
 *     <common payload>
 *
 *   common payload
 *     token             (bytes32)
 *     amount            (uint256)
 *     recipient         (bytes32)
 *     callbackData.length (uint16) ‖ callbackData
 *     context.length      (uint16) ‖ context
 *
 * Everything is big-endian and tightly packed — no ABI padding anywhere.
 */

/** `bytes4(keccak256("OIF.Fill"))` — leads every serialised FillDescription. */
export const FILL_MAGIC = "0xd1252dff" as const;
/** `bytes4(keccak256("OIF.NotFilled"))` — leads every serialised NotFilledDescription. */
export const NOT_FILLED_MAGIC = "0x830c1e1c" as const;

/** Byte length of a serialised FillDescription with empty callbackData/context. */
export const FILL_DESCRIPTION_MIN_LENGTH = 172;
/** Byte length of a serialised NotFilledDescription with empty callbackData/context. */
export const NOT_FILLED_DESCRIPTION_MIN_LENGTH = 140;

const MAX_UINT16 = 0xffff;

/**
 * Byte length of a hex string. The 2-byte length prefixes are the only place
 * where a miscount silently produces a valid-looking but wrong preimage, so this
 * is deliberately strict about the shape of its input.
 */
function byteLength(value: `0x${string}`, field: string): number {
  if (!value.startsWith("0x")) throw new Error(`${field} must be 0x-prefixed hex`);
  const body = value.slice(2);
  if (body.length % 2 !== 0) throw new Error(`${field} has an odd number of hex digits`);
  const length = body.length / 2;
  if (length > MAX_UINT16) {
    // The contract library reverts with CallOutOfRange/ContextOutOfRange here.
    throw new Error(`${field} exceeds the uint16 length prefix (${length} > ${MAX_UINT16} bytes)`);
  }
  return length;
}

function assertUint32(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${field} must be a uint32, got ${value}`);
  }
  return value;
}

/**
 * Serialises a FillDescription: the source of truth for "this output was filled",
 * as attested by an oracle and verified by `OutputSettlerBase._isPayloadValid`.
 */
export function encodeFillDescription({
  solver,
  orderId,
  timestamp,
  output
}: Readonly<{
  /** bytes32 solver identifier as recorded by the fill (see `fillEvent.ts`). */
  solver: `0x${string}`;
  orderId: `0x${string}`;
  /** The uint32 timestamp emitted in OutputFilled — NOT a local clock. */
  timestamp: number;
  output: MandateOutput;
}>): `0x${string}` {
  return encodePacked(
    [
      "bytes4",
      "bytes32",
      "bytes32",
      "uint32",
      "bytes32",
      "uint256",
      "bytes32",
      "uint16",
      "bytes",
      "uint16",
      "bytes"
    ],
    [
      FILL_MAGIC,
      solver,
      orderId,
      assertUint32(timestamp, "timestamp"),
      output.token,
      output.amount,
      output.recipient,
      byteLength(output.callbackData, "callbackData"),
      output.callbackData,
      byteLength(output.context, "context"),
      output.context
    ]
  );
}

/**
 * Serialises a NotFilledDescription: the source of truth for the permanent
 * absence of a fill before `fillDeadline`, which enables an early refund.
 */
export function encodeNotFilledDescription({
  orderId,
  fillDeadline,
  output
}: Readonly<{
  orderId: `0x${string}`;
  fillDeadline: number;
  output: MandateOutput;
}>): `0x${string}` {
  return encodePacked(
    [
      "bytes4",
      "bytes32",
      "uint32",
      "bytes32",
      "uint256",
      "bytes32",
      "uint16",
      "bytes",
      "uint16",
      "bytes"
    ],
    [
      NOT_FILLED_MAGIC,
      orderId,
      assertUint32(fillDeadline, "fillDeadline"),
      output.token,
      output.amount,
      output.recipient,
      byteLength(output.callbackData, "callbackData"),
      output.callbackData,
      byteLength(output.context, "context"),
      output.context
    ]
  );
}

/**
 * keccak256 of a serialised FillDescription — the `dataHash` an input oracle
 * stores and `isProven` is queried with.
 */
export function hashFillDescription(
  args: Parameters<typeof encodeFillDescription>[0]
): `0x${string}` {
  return keccak256(encodeFillDescription(args));
}

/** keccak256 of a serialised NotFilledDescription. */
export function hashNotFilledDescription(
  args: Parameters<typeof encodeNotFilledDescription>[0]
): `0x${string}` {
  return keccak256(encodeNotFilledDescription(args));
}
