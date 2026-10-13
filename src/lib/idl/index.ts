import type { Idl } from "@coral-xyz/anchor";
import inputSettlerEscrowIdl from "./input_settler_escrow.json";
import outputSettlerSimpleIdl from "./output_settler_simple.json";
import polymerIdl from "./polymer.json";
import intentsProtocolIdl from "./intents_protocol.json";
import wormholeIdl from "./wormhole.json";

// IDLs are copied VERBATIM from catalyst-intent-svm/idl. Never
// hand-edit them: `anchor build` regenerates them and any local tweak is lost
// silently, taking the instruction encoding with it. Re-copy instead.
//
// Anchor's generated `Idl` type is stricter than what `resolveJsonModule`
// infers from the literal (enum-ish fields widen to `string`), so the casts
// below are unavoidable. They are safe precisely because the files are
// unmodified compiler output.
export const INPUT_SETTLER_ESCROW_IDL = inputSettlerEscrowIdl as unknown as Idl;
export const OUTPUT_SETTLER_SIMPLE_IDL = outputSettlerSimpleIdl as unknown as Idl;
export const POLYMER_IDL = polymerIdl as unknown as Idl;
export const INTENTS_PROTOCOL_IDL = intentsProtocolIdl as unknown as Idl;
export const WORMHOLE_IDL = wormholeIdl as unknown as Idl;

// Program ids come from the TOP-LEVEL `address` field of each IDL — NOT from
// `metadata`, which in Anchor >= 0.30 only carries name/version/spec. Reading
// `metadata.address` yields `undefined` and silently derives every PDA from a
// garbage program id.
//
// A program id does not assert deployment on a cluster; readiness checks live code.
export const INPUT_SETTLER_ESCROW_PROGRAM_ID = inputSettlerEscrowIdl.address;
export const OUTPUT_SETTLER_SIMPLE_PROGRAM_ID = outputSettlerSimpleIdl.address;
export const POLYMER_PROGRAM_ID = polymerIdl.address;
export const INTENTS_PROTOCOL_PROGRAM_ID = intentsProtocolIdl.address;
export const WORMHOLE_PROGRAM_ID = wormholeIdl.address;

/** Every deployed program id, keyed by the IDL's own `metadata.name`. */
export const SOLANA_PROGRAM_IDS = {
  input_settler_escrow: INPUT_SETTLER_ESCROW_PROGRAM_ID,
  output_settler_simple: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  polymer: POLYMER_PROGRAM_ID,
  wormhole: WORMHOLE_PROGRAM_ID,
  intents_protocol: INTENTS_PROTOCOL_PROGRAM_ID
} as const;
