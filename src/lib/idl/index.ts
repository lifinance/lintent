import type { InputSettlerEscrow } from "./types/input_settler_escrow";
import type { OutputSettlerSimple } from "./types/output_settler_simple";
import type { Polymer } from "./types/polymer";
import type { IntentsProtocol } from "./types/intents_protocol";
import inputSettlerEscrowIdl from "./input_settler_escrow.json";
import outputSettlerSimpleIdl from "./output_settler_simple.json";
import polymerIdl from "./polymer.json";
import intentsProtocolIdl from "./intents_protocol.json";

// Verbatim corrected production bundle from lifi-intent-svm PR #127, 0072887.
// provenance.json pins source 776773a and every generated artifact. Anchor
// converts snake-case JSON names to the accompanying camel-case client types.
export const INPUT_SETTLER_ESCROW_IDL = inputSettlerEscrowIdl as unknown as InputSettlerEscrow;
export const OUTPUT_SETTLER_SIMPLE_IDL = outputSettlerSimpleIdl as unknown as OutputSettlerSimple;
export const POLYMER_IDL = polymerIdl as unknown as Polymer;
export const INTENTS_PROTOCOL_IDL = intentsProtocolIdl as unknown as IntentsProtocol;

// Program ids come from the TOP-LEVEL `address` field of each IDL — NOT from
// `metadata`, which in Anchor >= 0.30 only carries name/version/spec. Reading
// `metadata.address` yields `undefined` and silently derives every PDA from a
// garbage program id.
//
// Devnet and mainnet share these ids (the programs are deployed to the same
// vanity keypairs), so there is deliberately no per-chain lookup here.
export const INPUT_SETTLER_ESCROW_PROGRAM_ID = inputSettlerEscrowIdl.address;
export const OUTPUT_SETTLER_SIMPLE_PROGRAM_ID = outputSettlerSimpleIdl.address;
export const POLYMER_PROGRAM_ID = polymerIdl.address;
export const INTENTS_PROTOCOL_PROGRAM_ID = intentsProtocolIdl.address;

/** Every deployed program id, keyed by the IDL's own `metadata.name`. */
export const SOLANA_PROGRAM_IDS = {
  input_settler_escrow: INPUT_SETTLER_ESCROW_PROGRAM_ID,
  output_settler_simple: OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  polymer: POLYMER_PROGRAM_ID,
  intents_protocol: INTENTS_PROTOCOL_PROGRAM_ID
} as const;
