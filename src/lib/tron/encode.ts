import { BYTES32_ZERO, idToToken, ADDRESS_ZERO } from "@lifi/intent";
import type { EVMOrder, MandateOutput } from "@lifi/intent";

// TronLink's injected ethers.js v6 replaces `address`-type coders with
// Tron-specific ones that lose their localName, so encoding a named object
// fails with "cannot encode object for signature with missing names".
// Everything below therefore encodes structs as POSITIONAL ARRAYS
// (index-based matching), and converts address-typed fields to Tron base58
// via the caller-provided `toBase58` so TronLink encodes them correctly.
// Field order matches the deployed ABI (see src/lib/abi/tron.ts and
// tests/fixtures/tron/PREFLIGHT.md) — do not reorder.

/** MandateOutput → positional tuple. All fields are bytes32/uint/bytes — no
 * address conversion needed. */
export function outputToTuple(o: MandateOutput): unknown[] {
  return [
    o.oracle,
    o.settler,
    o.chainId.toString(),
    o.token,
    o.amount.toString(),
    o.recipient,
    o.callbackData,
    o.context
  ];
}

/** StandardOrder → positional tuple for `open`/`finalise`. `user` and
 * `inputOracle` are ABI `address` fields and must be base58 for TronLink. */
export function orderToTuple(order: EVMOrder, toBase58: (hex: `0x${string}`) => string): unknown[] {
  return [
    toBase58(order.user),
    order.nonce.toString(),
    order.originChainId.toString(),
    order.expires,
    order.fillDeadline,
    toBase58(order.inputOracle),
    order.inputs.map(([token, amount]) => [token.toString(), amount.toString()]),
    order.outputs.map(outputToTuple)
  ];
}

/** SolveParams[] → positional tuples [(uint32 timestamp, bytes32 solver)]. */
export function solveParamsToTuples(
  params: { timestamp: number; solver: `0x${string}` }[]
): unknown[][] {
  return params.map(({ timestamp, solver }) => [Math.floor(timestamp), solver]);
}

/** The new-generation `fillOrderOutputs` takes `bytes fillerData` whose first
 * 32 bytes are the proposed solver (FillerDataLib layout). */
export function solverToFillerData(solverBytes32: `0x${string}`): `0x${string}` {
  if (solverBytes32.length !== 66) {
    throw new Error(`fillerData solver must be bytes32, got ${solverBytes32}`);
  }
  return solverBytes32;
}

/** Sum of native (zero-token) output amounts — the callValue a fill must attach. */
export function nativeValueOfOutputs(outputs: readonly MandateOutput[]): bigint {
  let sum = 0n;
  for (const output of outputs) {
    if (output.token === BYTES32_ZERO) sum += output.amount;
  }
  return sum;
}

/** Sum of native input amounts — the callValue `open` must attach. Input token
 * ids are uint256 token identifiers whose low 20 bytes are the token address. */
export function nativeValueOfInputs(inputs: readonly [bigint, bigint][]): bigint {
  let sum = 0n;
  for (const [tokenId, amount] of inputs) {
    if (idToToken(tokenId).toLowerCase() === ADDRESS_ZERO) sum += amount;
  }
  return sum;
}

/**
 * Worst-case amount a fill of this output can transfer. Limit and
 * exclusive-limit outputs pay exactly `amount`; Dutch auctions (0x01 / 0xe1)
 * resolve to `amount + slope × (stopTime − now)`, bounded above by
 * `amount + slope × (stopTime − startTime)` — allowances sized from the bare
 * `amount` would under-approve them.
 * Context layouts per OutputSettlerSimple/FulfilmentLib:
 *   0x01: type(1) ‖ startTime(u32) ‖ stopTime(u32) ‖ slope(u256)
 *   0xe1: type(1) ‖ exclusiveFor(b32) ‖ startTime(u32) ‖ stopTime(u32) ‖ slope(u256)
 */
export function maxResolvedAmount(output: MandateOutput): bigint {
  const hex = output.context.replace(/^0x/, "").toLowerCase();
  const typeByte = hex.substring(0, 2);
  let offset: number;
  if (typeByte === "01" && hex.length === 82) offset = 2;
  else if (typeByte === "e1" && hex.length === 146) offset = 66;
  else return output.amount;
  const startTime = BigInt(`0x${hex.substring(offset, offset + 8)}`);
  const stopTime = BigInt(`0x${hex.substring(offset + 8, offset + 16)}`);
  const slope = BigInt(`0x${hex.substring(offset + 16, offset + 80)}`);
  if (stopTime <= startTime) return output.amount;
  return output.amount + slope * (stopTime - startTime);
}

/** tronweb `send({ callValue })` takes a JS number (SUN). Guard the narrowing. */
export function toCallValue(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`callValue ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}
