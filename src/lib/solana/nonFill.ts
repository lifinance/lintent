// Raw instruction builders for the Solana non-fill (fast refund) path.
//
// Built by hand rather than through Anchor because the vendored IDLs predate
// the in-place "rent reclamation" upgrade: they have no `submit_consume`, and
// their `refund_on_non_fill` lists the old 11 accounts, which the upgraded
// program rejects. Layouts are ported from ../intents-auto-refund
// (core/solana/destination-instructions.ts, core/solana/refund-instruction.ts,
// adapters/solana/destination-safety.ts) and pinned in solanaNonFill.test.ts.

import { base64 } from "@scure/base";
import {
  borshEncodeSolanaOrder,
  encodeNotFilledDescription,
  getNotFilledDescriptionHash,
  getOutputHash
} from "@lifi/intent";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import { PublicKey, Transaction } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "viem";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  POLYMER_PROGRAM_ID
} from "$lib/idl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  associatedTokenAddress,
  bytes32ToPubkey,
  fillIdPda,
  inputSettlerEscrowPda,
  localAttestationPda,
  localConsumerPda,
  orderContextPda,
  outputSettlerSimplePda,
  polymerOraclePda
} from "./pda";
import type { SolanaAccountInfoLike, SolanaAccountMeta, SolanaInstructionLike } from "./types";

// Anchor discriminators: sha256("global:<ix>")[..8] / sha256("account:<Name>")[..8].
// Pinned as literals and re-derived in the tests so a rename cannot slip.
export const ATTEST_NOT_FILLED_DISCRIMINATOR = Uint8Array.from([
  93, 101, 204, 135, 226, 64, 5, 137
]);
export const SUBMIT_CONSUME_DISCRIMINATOR = Uint8Array.from([19, 162, 196, 241, 27, 133, 47, 49]);
export const REFUND_ON_NON_FILL_DISCRIMINATOR = Uint8Array.from([
  53, 164, 197, 243, 243, 43, 185, 108
]);
export const LOCAL_ATTESTATION_DISCRIMINATOR = Uint8Array.from([
  173, 247, 101, 168, 96, 238, 17, 22
]);
export const CHAIN_MAPPING_DISCRIMINATOR = Uint8Array.from([81, 78, 77, 209, 44, 206, 85, 169]);

/**
 * `attest_not_filled` may only mint within `(fillDeadline, fillDeadline + window]`;
 * after that every FillRecord becomes permissionlessly closable. Mirrors
 * `output_settler_base::constants::NOT_FILLED_WINDOW_SECONDS`.
 */
export const NOT_FILLED_WINDOW_SECS = 172_800;
/** Safety margin before the window end, covering clock skew and inclusion latency. */
export const MINT_WINDOW_MARGIN_SECS = 600;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32Le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`value does not fit u32: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/**
 * `BigInt(value)` because containers rehydrated from the local DB carry
 * decimal strings in their bigint fields (see toBytes32 in ./writes.ts).
 */
function u256Be(value: bigint, label: string): Uint8Array {
  let rest = BigInt(value);
  if (rest < 0n || rest >= 1n << 256n) throw new Error(`${label} does not fit u256: ${rest}`);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function bytes32(value: `0x${string}`, label: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

const signerMeta = (pubkey: string): SolanaAccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: true
});
const meta = (pubkey: string, isWritable = false): SolanaAccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable
});

/** Anchor/Borsh encoding of the Rust `MandateOutput` instruction argument. */
export function encodeBorshMandateOutput(output: MandateOutput): Uint8Array {
  const callbackData = hexToBytes(output.callbackData);
  const context = hexToBytes(output.context);
  return concat([
    bytes32(output.oracle, "output.oracle"),
    bytes32(output.settler, "output.settler"),
    u256Be(output.chainId, "output.chainId"),
    bytes32(output.token, "output.token"),
    u256Be(output.amount, "output.amount"),
    bytes32(output.recipient, "output.recipient"),
    u32Le(callbackData.length),
    callbackData,
    u32Le(context.length),
    context
  ]);
}

type NotFilledArgs = { orderId: `0x${string}`; output: MandateOutput; fillDeadline: number };

/**
 * The record's LocalAttestation. Its consumer is `output.oracle`, which for a
 * provable Solana output IS the Polymer program id — the consumer
 * `submit_consume` signs for through its `local_consumer` PDA.
 */
function notFilledLocalAttestation(a: NotFilledArgs): string {
  return localAttestationPda(
    outputSettlerSimplePda(),
    a.output.oracle,
    getNotFilledDescriptionHash(a)
  ).toBase58();
}

/** Permissionless `attest_not_filled(order_id, output, fill_deadline)` on the output settler. */
export function buildAttestNotFilledInstruction(
  a: NotFilledArgs & { payer: string }
): SolanaInstructionLike {
  return {
    programId: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
    keys: [
      signerMeta(a.payer),
      meta(outputSettlerSimplePda().toBase58()),
      meta(fillIdPda(a.orderId, getOutputHash(a.output)).toBase58()),
      meta(notFilledLocalAttestation(a), true),
      meta(INTENTS_PROTOCOL_PROGRAM_ID),
      meta(SYSTEM_PROGRAM_ID)
    ],
    data: concat([
      ATTEST_NOT_FILLED_DISCRIMINATOR,
      bytes32(a.orderId, "orderId"),
      encodeBorshMandateOutput(a.output),
      u32Le(a.fillDeadline)
    ])
  };
}

/**
 * `oracle_polymer::submit_consume(source, vec![payload])`: emits the `Prove:`
 * log and closes the attestation in one instruction. `rentRefund` must equal
 * the payer stored on the attestation, or the consume CPI rejects it.
 */
export function buildSubmitConsumeNotFilledInstruction(
  a: NotFilledArgs & { payer: string; rentRefund: string }
): SolanaInstructionLike {
  const payload = hexToBytes(encodeNotFilledDescription(a));
  return {
    programId: POLYMER_PROGRAM_ID,
    keys: [
      signerMeta(a.payer),
      meta(polymerOraclePda().toBase58()),
      meta(localConsumerPda(POLYMER_PROGRAM_ID).toBase58()),
      meta(INTENTS_PROTOCOL_PROGRAM_ID),
      meta(notFilledLocalAttestation(a), true),
      meta(a.rentRefund, true)
    ],
    data: concat([
      SUBMIT_CONSUME_DISCRIMINATOR,
      outputSettlerSimplePda().toBytes(),
      u32Le(1),
      u32Le(payload.length),
      payload
    ])
  };
}

/**
 * `refund_on_non_fill(order, output_index)`: `Refund`'s 11 accounts with
 * `local_consumer` and the intents protocol inserted after `mint`, then
 * exactly two remaining accounts `[attestation, rent_refund]`. The program
 * demands the pair even for a remote Attestation, whose rent slot it never
 * reads, so the signer (already in the transaction) fills it.
 */
export function buildRefundOnNonFillInstruction(a: {
  signer: string;
  order: StandardSolana;
  orderId: `0x${string}`;
  sponsor: string;
  tokenProgramId: string;
  outputIndex: number;
  attestation: string;
}): SolanaInstructionLike {
  if (!Number.isInteger(a.outputIndex) || a.outputIndex < 0 || a.outputIndex > 255) {
    throw new Error(`output index out of u8 range: ${a.outputIndex}`);
  }
  const [input] = a.order.inputs;
  if (!input) throw new Error("A Solana order must have exactly one input");
  const mint = bytes32ToPubkey(`0x${BigInt(input[0]).toString(16).padStart(64, "0")}`).toBase58();
  const user = bytes32ToPubkey(a.order.user as `0x${string}`).toBase58();
  const orderContext = orderContextPda(a.orderId).toBase58();
  return {
    programId: INPUT_SETTLER_ESCROW_PROGRAM_ID,
    keys: [
      signerMeta(a.signer),
      meta(user),
      meta(a.sponsor, true),
      meta(inputSettlerEscrowPda().toBase58()),
      meta(orderContext, true),
      meta(associatedTokenAddress(mint, orderContext, a.tokenProgramId).toBase58(), true),
      meta(associatedTokenAddress(mint, user, a.tokenProgramId).toBase58(), true),
      // Writable: Token-2022 fee harvest writes withheld fees back to the mint.
      meta(mint, true),
      meta(localConsumerPda(INPUT_SETTLER_ESCROW_PROGRAM_ID).toBase58()),
      meta(INTENTS_PROTOCOL_PROGRAM_ID),
      meta(a.tokenProgramId),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SYSTEM_PROGRAM_ID),
      meta(a.attestation),
      meta(a.signer)
    ],
    data: concat([
      REFUND_ON_NON_FILL_DISCRIMINATOR,
      borshEncodeSolanaOrder(a.order),
      Uint8Array.of(a.outputIndex)
    ])
  };
}

/**
 * ATA `CreateIdempotent` for the refund recipient. The escrow's
 * `user_token_account` has no `init_if_needed`, so a user who closed their ATA
 * would otherwise fail every refund with `AccountNotInitialized`.
 */
export function buildCreateAtaIdempotentInstruction(a: {
  payer: string;
  owner: string;
  mint: string;
  tokenProgramId: string;
}): SolanaInstructionLike {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      signerMeta(a.payer),
      meta(associatedTokenAddress(a.mint, a.owner, a.tokenProgramId).toBase58(), true),
      meta(a.owner),
      meta(a.mint),
      meta(SYSTEM_PROGRAM_ID),
      meta(a.tokenProgramId)
    ],
    data: Uint8Array.of(1)
  };
}

/** The exact log `msg!("Prove: program: {}, {}", ...)` emits for this record. */
export function expectedNotFilledProveLog(a: NotFilledArgs): string {
  const bytes = concat([
    outputSettlerSimplePda().toBytes(),
    hexToBytes(encodeNotFilledDescription(a))
  ]);
  return `Program log: Prove: program: ${POLYMER_PROGRAM_ID}, ${base64.encode(bytes)}`;
}

export type NotFilledLocalAttestation =
  | { kind: "absent" }
  | { kind: "current"; rentRefund: string }
  | { kind: "consumed" }
  | { kind: "legacy" };

/** Pre-upgrade layout: disc(8) ‖ timestamp u32 LE ‖ bump. */
const LEGACY_LOCAL_ATTESTATION_LENGTH = 13;
/** Rent-reclamation layout: … ‖ rent_refund(32) ‖ consumed(bool). */
const LOCAL_ATTESTATION_LENGTH = 46;
const RENT_REFUND_OFFSET = 13;
const CONSUMED_OFFSET = 45;

/**
 * Classifies the record's LocalAttestation account. Anything not exactly one of
 * the known shapes throws: guessing would either double-spend rent or submit a
 * record that cannot be consumed.
 */
export function classifyLocalAttestation(
  account: SolanaAccountInfoLike,
  expectedTimestamp: number
): NotFilledLocalAttestation {
  if (!account || (account.owner === SYSTEM_PROGRAM_ID && account.data.length === 0)) {
    return { kind: "absent" };
  }
  const { owner, data } = account;
  if (owner !== INTENTS_PROTOCOL_PROGRAM_ID) {
    throw new Error(`local attestation is owned by unexpected program ${owner}`);
  }
  if (data.length !== LEGACY_LOCAL_ATTESTATION_LENGTH && data.length !== LOCAL_ATTESTATION_LENGTH) {
    throw new Error(`unsupported local attestation length ${data.length}`);
  }
  if (!LOCAL_ATTESTATION_DISCRIMINATOR.every((byte, i) => data[i] === byte)) {
    throw new Error("local attestation has the wrong discriminator");
  }
  const timestamp = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8, true);
  if (timestamp !== expectedTimestamp) {
    throw new Error(
      `local attestation timestamp ${timestamp} != expected timestamp ${expectedTimestamp}`
    );
  }
  if (data.length === LEGACY_LOCAL_ATTESTATION_LENGTH) return { kind: "legacy" };
  const rentRefund = data.subarray(RENT_REFUND_OFFSET, CONSUMED_OFFSET);
  if (rentRefund.every((byte) => byte === 0)) {
    throw new Error("local attestation has an unusable rent-refund address");
  }
  switch (data[CONSUMED_OFFSET]) {
    case 0:
      return { kind: "current", rentRefund: bytes32ToPubkey(bytesToHex(rentRefund)).toBase58() };
    case 1:
      return { kind: "consumed" };
    default:
      throw new Error(`local attestation has invalid consumed flag ${data[CONSUMED_OFFSET]}`);
  }
}

/**
 * Serialized size of a legacy transaction carrying `instructions`, checked
 * against the 1232-byte packet limit before any spend. The blockhash is a
 * dummy: it is fixed-width, so it does not change the size.
 */
export async function estimateLegacyTxSize(
  instructions: SolanaInstructionLike[],
  feePayer: string
): Promise<number> {
  const tx = new Transaction({
    feePayer: new PublicKey(feePayer),
    recentBlockhash: "11111111111111111111111111111111"
  });
  for (const ix of instructions) {
    tx.add({
      programId: new PublicKey(ix.programId),
      keys: ix.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
      data: Buffer.from(ix.data)
    });
  }
  const message = tx.compileMessage();
  const signatures = message.header.numRequiredSignatures;
  // compact-u16 signature count (1 byte below 128) + 64 bytes per signature.
  return message.serialize().length + 1 + 64 * signatures;
}
