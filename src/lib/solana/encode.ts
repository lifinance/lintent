// Solana payload encoding.
//
// Everything here is pure: viem plus @lifi/intent, no SDK imports. Anchor
// argument shaping (PublicKey/BN) lives in the writes layer, so these helpers
// stay testable without loading @solana/web3.js.
//
// Where @lifi/intent already encodes a payload byte-for-byte the same way the
// on-chain programs do, this module re-exports it rather than reimplementing:
// two encoders that must agree forever are one encoder too many.

import { BYTES32_ZERO, FILL_MAGIC, encodeFillDescription, getOutputHash } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { encodePacked, hexToBytes, keccak256 } from "viem";

/** Largest amount the Solana output settler can resolve; it works in u64. */
export const U64_MAX = (1n << 64n) - 1n;

function byteLength(value: `0x${string}`): number {
  return (value.length - 2) / 2;
}

/**
 * The shared tail of every OIF output payload:
 * `token(32)‖amount(32)‖recipient(32)‖uint16(cbLen)‖cb‖uint16(ctxLen)‖ctx`.
 *
 * Mirrors `encode_common_payload` in
 * catalyst-intent-svm/common/src/encoding/mandate_output_encoding_lib.rs.
 */
export function commonPayload(output: MandateOutput): `0x${string}` {
  return encodePacked(
    ["bytes32", "uint256", "bytes32", "uint16", "bytes", "uint16", "bytes"],
    [
      output.token,
      output.amount,
      output.recipient,
      byteLength(output.callbackData),
      output.callbackData,
      byteLength(output.context),
      output.context
    ]
  );
}

/**
 * A FillDescription with the timestamp field omitted:
 * `FILL_MAGIC(4)‖solver(32)‖orderId(32)‖commonPayload`.
 *
 * This is NOT the payload Polymer proves — that one carries the timestamp and
 * comes from `encodeFillDescription`. This variant exists because its hash is
 * used as a PDA seed, and a seed cannot depend on the fill timestamp (the
 * account has to be derivable before the fill lands). The on-chain program
 * verifies the timestamp separately, out of the LocalAttestation account.
 *
 * Mirrors `encode_fill_description_without_timestamp` in the Rust encoding lib.
 * Conflating the two variants derives an attestation account that never
 * exists, so they are deliberately named apart.
 */
export function fillDescriptionWithoutTimestamp(args: {
  solver: `0x${string}`;
  orderId: `0x${string}`;
  output: MandateOutput;
}): `0x${string}` {
  return encodePacked(
    ["bytes4", "bytes32", "bytes32", "bytes"],
    [FILL_MAGIC, args.solver, args.orderId, commonPayload(args.output)]
  );
}

/** `data_hash` of the LocalAttestation a Solana fill creates. */
export function localAttestationDataHash(args: {
  solver: `0x${string}`;
  orderId: `0x${string}`;
  output: MandateOutput;
}): `0x${string}` {
  return keccak256(fillDescriptionWithoutTimestamp(args));
}

/**
 * `payload_hash` of the remote Attestation created when a fill is proven
 * across chains. Unlike {@link localAttestationDataHash} this one includes the
 * timestamp.
 */
export function fillPayloadHash(args: {
  solver: `0x${string}`;
  orderId: `0x${string}`;
  timestamp: number;
  output: MandateOutput;
}): `0x${string}` {
  return keccak256(encodeFillDescription(args));
}

/**
 * `filler_data` for `output_settler_simple::fill`.
 *
 * `resolve_output` requires exactly 32 bytes and rejects the zero pubkey, so
 * both are checked here — a wrong length or a zero solver otherwise surfaces
 * as an opaque program error after the transaction has been signed.
 */
export function solverToFillerData(solverBytes32: `0x${string}`): Uint8Array {
  const bytes = hexToBytes(solverBytes32);
  if (bytes.length !== 32) {
    throw new Error(`filler_data must be a 32-byte solver identity, got ${bytes.length} bytes`);
  }
  if (BigInt(solverBytes32) === 0n) {
    throw new Error("filler_data must not be the zero pubkey");
  }
  return bytes;
}

/** Whether an output is native SOL, which fills through `native_fill`. */
export function isNativeSolanaOutput(output: MandateOutput): boolean {
  return output.token === BYTES32_ZERO;
}

/**
 * MandateOutput.amount is bytes32 on the wire but u64 on Solana. Fail before
 * signing rather than letting the program revert mid-fill.
 */
export function assertSolanaAmountFitsU64(output: MandateOutput): void {
  if (output.amount > U64_MAX) {
    throw new Error(
      `Solana output amount ${output.amount} exceeds u64; the output settler cannot fill it`
    );
  }
}

// The Solana `mandate_output_hash` (the FillId seed) is byte-identical to the
// library's getOutputHash — verified in tests/unit/solanaEncode.test.ts against
// the Rust layout. Re-exported so callers never hand-roll a second one.
export { getOutputHash };
