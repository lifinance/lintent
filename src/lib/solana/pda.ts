import { PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "viem";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  POLYMER_PROGRAM_ID
} from "$lib/idl";

// PDA seeds, transcribed from the Rust `constants.rs` of each program. Kept as
// literals rather than re-derived from the IDL because Anchor only emits seeds
// for `seeds::program`-style constant seeds — the `order_id`/hash seeds below
// are instruction-argument derived and never appear in the IDL at all.
//   programs/protocol/src/constants.rs
//   programs/inputs/input_settler_escrow/src/constants.rs
//   programs/outputs/output_settler_simple/src/constants.rs
//   programs/oracles/oracle_polymer/src/constants.rs
export const SOLANA_PDA_SEEDS = {
  chainId: "chain_id",
  chainMapping: "chain_mapping",
  localAttestation: "local_attestation",
  attestation: "attestation",
  inputSettlerEscrow: "input_settler_escrow",
  orderContext: "order_context",
  consumedOrder: "consumed_order",
  outputSettlerSimple: "output_settler_simple",
  // NOTE: the polymer oracle's singleton seed is "polymer", not the IDL name
  // "oracle_polymer" — see POLYMER_ORACLE_SEED.
  polymerOracle: "polymer"
} as const;

const utf8 = new TextEncoder();

/** 32-byte hex (the form every `MandateOutput` field uses) → raw seed bytes. */
function bytes32Seed(value: `0x${string}`, label: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * `u128` → 16 little-endian bytes.
 *
 * Solana's `to_le_bytes()` is the ONLY endianness used in seeds, and it is the
 * opposite of the big-endian `chain_id` carried inside a `MandateOutput`. A
 * big-endian seed derives a valid-looking but wrong PDA, so the conversion is
 * isolated here rather than inlined at each call site.
 */
export function u128ToLeBytes(value: bigint): Uint8Array {
  // `BigInt(value)` despite the `bigint` type: an order container that has been
  // through the local DB carries decimal STRINGS in its bigint fields (see
  // toBytes32 in ./writes.ts), and `"…" & 0xffn` throws "Cannot mix BigInt and
  // other types" — which killed every attestationPda/chainMappingPda derivation
  // for a rehydrated order.
  const asBigInt = BigInt(value);
  if (asBigInt < 0n || asBigInt >= 1n << 128n) {
    throw new Error(`chain id ${asBigInt} does not fit in u128`);
  }
  const bytes = new Uint8Array(16);
  let rest = asBigInt;
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

/** A PDA's raw key as bytes32 hex — the form `MandateOutput`/`StandardOrder` fields take. */
export function pubkeyToBytes32(key: PublicKey): `0x${string}` {
  return bytesToHex(key.toBytes());
}

/** bytes32 hex → `PublicKey`, for feeding an on-chain-encoded key back into a derivation. */
export function bytes32ToPubkey(value: `0x${string}`): PublicKey {
  return new PublicKey(bytes32Seed(value, "pubkey"));
}

// `findProgramAddressSync` is canonical-bump-by-construction: it walks bumps
// 255→0 and returns the first off-curve hit, which is exactly what Anchor's
// `bump` (no explicit value) constraint enforces on-chain. Never accept a
// caller-supplied bump here.
function derive(seeds: (Uint8Array | string)[], programId: string): PublicKey {
  const raw = seeds.map((seed) => (typeof seed === "string" ? utf8.encode(seed) : seed));
  return PublicKey.findProgramAddressSync(raw, new PublicKey(programId))[0];
}

/** The protocol's singleton `ChainId` account, holding this cluster's protocol chain id. */
export function chainIdPda(programId: string = INTENTS_PROTOCOL_PROGRAM_ID): PublicKey {
  return derive([SOLANA_PDA_SEEDS.chainId], programId);
}

/**
 * The input settler escrow's singleton state PDA — the value a `StandardOrder`'s
 * input settler field must hold. NOT the program id: the program id signs
 * nothing, the PDA does.
 */
export function inputSettlerEscrowPda(
  programId: string = INPUT_SETTLER_ESCROW_PROGRAM_ID
): PublicKey {
  return derive([SOLANA_PDA_SEEDS.inputSettlerEscrow], programId);
}

/**
 * The output settler's singleton state PDA — the value `MandateOutput.settler`
 * must hold (`validate_settler_is_output_settler` compares against this key).
 */
export function outputSettlerSimplePda(
  programId: string = OUTPUT_SETTLER_SIMPLE_PROGRAM_ID
): PublicKey {
  return derive([SOLANA_PDA_SEEDS.outputSettlerSimple], programId);
}

/**
 * The Polymer oracle's singleton state PDA — the value `StandardOrder.inputOracle`
 * must hold when Solana is the INPUT chain.
 *
 * Do NOT use this for `MandateOutput.oracle`: `oracle_polymer::submit` compares
 * the fill's `LocalAttestation.consumer` against its own PROGRAM ID, so a fill
 * whose output oracle is this PDA can never be proven.
 */
export function polymerOraclePda(programId: string = POLYMER_PROGRAM_ID): PublicKey {
  return derive([SOLANA_PDA_SEEDS.polymerOracle], programId);
}

/** Per-order escrow bookkeeping, and the authority owning the escrowed ATAs. */
export function orderContextPda(
  orderId: `0x${string}`,
  programId: string = INPUT_SETTLER_ESCROW_PROGRAM_ID
): PublicKey {
  return derive([SOLANA_PDA_SEEDS.orderContext, bytes32Seed(orderId, "orderId")], programId);
}

/** Replay marker: `open` creates it, so a second open of the same order id fails. */
export function consumedOrderPda(
  orderId: `0x${string}`,
  programId: string = INPUT_SETTLER_ESCROW_PROGRAM_ID
): PublicKey {
  return derive([SOLANA_PDA_SEEDS.consumedOrder, bytes32Seed(orderId, "orderId")], programId);
}

/**
 * The fill record. Seeds are `[order_id, mandateOutputHash]` with NO string
 * prefix — unlike every other PDA here. `attest_not_filled` proves a non-fill by
 * checking this account is still system-owned and empty, so getting the seeds
 * wrong turns "already filled" into "provably not filled".
 */
export function fillIdPda(
  orderId: `0x${string}`,
  mandateOutputHash: `0x${string}`,
  programId: string = OUTPUT_SETTLER_SIMPLE_PROGRAM_ID
): PublicKey {
  return derive(
    [bytes32Seed(orderId, "orderId"), bytes32Seed(mandateOutputHash, "mandateOutputHash")],
    programId
  );
}

/**
 * A same-chain attestation written by `intents_protocol::create_local_attestation`.
 *
 * `attestator` is the settler PDA that signed the CPI (not the filler),
 * `consumer` is `MandateOutput.oracle`, and `dataHash` is the fill description
 * hash WITHOUT the timestamp (see `fillLocalAttestationDataHash` in ./encode).
 */
export function localAttestationPda(
  attestator: PublicKey,
  consumer: `0x${string}`,
  dataHash: `0x${string}`,
  programId: string = INTENTS_PROTOCOL_PROGRAM_ID
): PublicKey {
  return derive(
    [
      SOLANA_PDA_SEEDS.localAttestation,
      attestator.toBytes(),
      bytes32Seed(consumer, "consumer"),
      bytes32Seed(dataHash, "dataHash")
    ],
    programId
  );
}

/**
 * A remote attestation written by `intents_protocol::create_attestation` once an
 * oracle has verified a proof from `chainId`.
 *
 * `attestator` is the oracle PDA that signed the CPI, and `payloadHash` is the
 * FULL fill description hash — the one that DOES include the timestamp.
 */
export function attestationPda(
  attestator: PublicKey,
  chainId: bigint,
  source: `0x${string}`,
  application: `0x${string}`,
  payloadHash: `0x${string}`,
  programId: string = INTENTS_PROTOCOL_PROGRAM_ID
): PublicKey {
  return derive(
    [
      SOLANA_PDA_SEEDS.attestation,
      attestator.toBytes(),
      u128ToLeBytes(chainId),
      bytes32Seed(source, "source"),
      bytes32Seed(application, "application"),
      bytes32Seed(payloadHash, "payloadHash")
    ],
    programId
  );
}

/** Maps a protocol chain id to a Polymer/Wormhole-native chain id for `oracle`. */
export function chainMappingPda(
  oracle: PublicKey,
  protocolChainId: bigint,
  programId: string = INTENTS_PROTOCOL_PROGRAM_ID
): PublicKey {
  return derive(
    [SOLANA_PDA_SEEDS.chainMapping, oracle.toBytes(), u128ToLeBytes(protocolChainId)],
    programId
  );
}

/** SPL Token program. Mints created before Token-2022 are owned by this one. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022. The settlers accept either via Anchor's `TokenInterface`. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/**
 * The associated token account for (mint, owner).
 *
 * Every token account in the escrow and settler instructions is constrained
 * `associated_token::…`, so this derivation — not an arbitrary token account —
 * is the only address the programs accept.
 *
 * `tokenProgramId` is a parameter because the mint's owning program is part of
 * the seed: the same mint address under Token-2022 yields a different ATA, and
 * passing the wrong one derives an account the program will reject.
 */
export function associatedTokenAddress(
  mint: string,
  owner: string,
  tokenProgramId: string = TOKEN_PROGRAM_ID
): PublicKey {
  return derive(
    [
      new PublicKey(owner).toBytes(),
      new PublicKey(tokenProgramId).toBytes(),
      new PublicKey(mint).toBytes()
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

/**
 * Polymer's prover program.
 *
 * An external program, not one of ours. The authoritative value lives on chain
 * in `OraclePolymer.polymer_prover_id`; this constant is the value read from
 * BOTH mainnet and devnet (they match), pinned so the receive path does not
 * need an extra round trip before every proof. `assertPolymerProverId` below
 * checks the pin against the account when it matters.
 */
export const POLYMER_PROVER_PROGRAM_ID = "CdvSq48QUukYuMczgZAVNZrwcHNshBdtqrjW26sQiGPs";

/**
 * The prover's scratch accounts: a proof is loaded into `cache`, validated
 * into `result`, and `internal` holds program-wide state.
 *
 * `cache` and `result` are per-authority, so two solvers proving concurrently
 * do not collide. `internal` is a singleton — its existence on both clusters,
 * owned by the prover program, is what confirms this seed scheme.
 */
export function polymerScratchPdas(
  authority: string,
  proverProgramId: string = POLYMER_PROVER_PROGRAM_ID
): { cache: string; result: string; internal: string } {
  const authorityBytes = new PublicKey(authority).toBytes();
  return {
    cache: derive([utf8.encode("cache"), authorityBytes], proverProgramId).toBase58(),
    result: derive([utf8.encode("result"), authorityBytes], proverProgramId).toBase58(),
    internal: derive([utf8.encode("internal")], proverProgramId).toBase58()
  };
}
