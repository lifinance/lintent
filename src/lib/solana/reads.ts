// Read-side Solana state.
//
// Almost every question the flow asks — was this filled, was it proven, is it
// finished — is answered on Solana by whether a PDA exists. The programs
// create marker accounts rather than writing status enums, so "account
// present" is the fact, and the account's owner is what makes it trustworthy:
// anyone can fund an address, only the program can own it.

import { getOutputHash } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import {
  INPUT_SETTLER_ESCROW_PROGRAM_ID,
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID
} from "$lib/idl";
import { localAttestationDataHash } from "./encode";
import {
  POLYMER_PROVER_PROGRAM_ID,
  associatedTokenAddress,
  attestationPda,
  bytes32ToPubkey,
  consumedOrderPda,
  fillIdPda,
  localAttestationPda,
  orderContextPda,
  outputSettlerSimplePda,
  polymerOraclePda
} from "./pda";
import type { SolanaConnectionLike } from "./types";

/**
 * Whether `address` holds a live account owned by `expectedOwner`.
 *
 * The owner check is the point. A PDA address is public and anyone can send
 * lamports to it, which creates a system-owned account there — so "an account
 * exists" alone would let a stranger fake a fill or an attestation for the
 * price of rent.
 */
async function accountExistsOwnedBy(
  reads: SolanaConnectionLike,
  address: string,
  expectedOwner: string
): Promise<boolean> {
  const info = await reads.getAccountInfo(address);
  return info?.owner === expectedOwner;
}

/** Whether the output settler has recorded a fill for this order and output. */
export async function readIsOutputFilled(
  reads: SolanaConnectionLike,
  args: { orderId: `0x${string}`; output: MandateOutput }
): Promise<boolean> {
  const fillId = fillIdPda(args.orderId, getOutputHash(args.output));
  return accountExistsOwnedBy(reads, fillId.toBase58(), OUTPUT_SETTLER_SIMPLE_PROGRAM_ID);
}

/**
 * Whether a same-chain fill has been locally attested.
 *
 * The attestator is the output settler PDA (it signs the CPI that creates the
 * attestation, so the filler's own key never appears), the consumer is
 * whatever the output named as its oracle, and the data hash is the
 * timestamp-free fill description — which is precisely why that variant
 * exists, since the account must be derivable without knowing when the fill
 * landed.
 */
export async function readIsLocallyAttested(
  reads: SolanaConnectionLike,
  args: { orderId: `0x${string}`; output: MandateOutput; solver: `0x${string}` }
): Promise<boolean> {
  const dataHash = localAttestationDataHash({
    solver: args.solver,
    orderId: args.orderId,
    output: args.output
  });
  const pda = localAttestationPda(outputSettlerSimplePda(), args.output.oracle, dataHash);
  return accountExistsOwnedBy(reads, pda.toBase58(), INTENTS_PROTOCOL_PROGRAM_ID);
}

/**
 * Whether a remote fill has been proven to this Solana input chain, i.e. the
 * oracle has created the Attestation account `finalise` will look for.
 *
 * `payloadHash` is the FULL fill description hash, including the timestamp —
 * not the one used for local attestations.
 */
export async function readIsProvenOnSolana(
  reads: SolanaConnectionLike,
  args: {
    inputOracle: `0x${string}`;
    output: MandateOutput;
    payloadHash: `0x${string}`;
  }
): Promise<boolean> {
  const pda = attestationPda(
    bytes32ToPubkey(args.inputOracle),
    args.output.chainId,
    args.output.oracle,
    args.output.settler,
    args.payloadHash
  );
  return accountExistsOwnedBy(reads, pda.toBase58(), INTENTS_PROTOCOL_PROGRAM_ID);
}

/** Whether the escrow still holds this order (i.e. it is open, not settled). */
export async function readIsOrderOpen(
  reads: SolanaConnectionLike,
  orderId: `0x${string}`
): Promise<boolean> {
  return accountExistsOwnedBy(
    reads,
    orderContextPda(orderId).toBase58(),
    INPUT_SETTLER_ESCROW_PROGRAM_ID
  );
}

/**
 * Whether the order has reached a terminal state on the input chain.
 *
 * There is no OrderStatus enum on Solana. `finalise` and `refund` BOTH close
 * `order_context` (returning its rent), while `consumed_order` is created at
 * open and never closed — so "context gone, consumed_order still there" is the
 * only available signal, and it means *terminal*, not specifically *claimed*.
 *
 * That matches how the app already treats EVM and Tron, where Claimed and
 * Refunded are folded into one state (flowProgress.ts, Finalise.svelte).
 * Telling them apart would mean scanning FinalisedEvent vs RefundedEvent, and
 * would need doing on all three chain types to be worth anything.
 */
export async function readIsOrderFinalised(
  reads: SolanaConnectionLike,
  orderId: `0x${string}`
): Promise<boolean> {
  const [context, consumed] = await reads.getMultipleAccountsInfo([
    orderContextPda(orderId).toBase58(),
    consumedOrderPda(orderId).toBase58()
  ]);
  const wasOpened = consumed?.owner === INPUT_SETTLER_ESCROW_PROGRAM_ID;
  const stillOpen = context?.owner === INPUT_SETTLER_ESCROW_PROGRAM_ID;
  return wasOpened && !stillOpen;
}

/** Native SOL balance, in lamports. */
export async function readSolBalance(
  reads: SolanaConnectionLike,
  ownerBase58: string
): Promise<bigint> {
  return reads.getBalance(ownerBase58);
}

/**
 * SPL balance for an owner and mint, via the associated token account.
 *
 * Resolves to 0n when the ATA does not exist: an account that has never been
 * funded is a zero balance, not an error, and surfacing it as one would put a
 * spurious failure in front of every user holding none of a listed token.
 */
export async function readSplBalance(
  reads: SolanaConnectionLike,
  args: { mintBytes32: `0x${string}`; ownerBase58: string; tokenProgramId?: string }
): Promise<bigint> {
  const mint = bytes32ToPubkey(args.mintBytes32).toBase58();
  // The mint's owning program is part of the ATA seed, so SPL and Token-2022
  // give different addresses for the same mint. Defaulting to SPL would read a
  // Token-2022 balance as zero, which looks like "you hold none" rather than
  // "we looked in the wrong place" — so resolve it unless the caller knows.
  const tokenProgramId = args.tokenProgramId ?? (await reads.getAccountInfo(mint))?.owner;
  if (!tokenProgramId) return 0n;
  const ata = associatedTokenAddress(mint, args.ownerBase58, tokenProgramId);
  return reads.getTokenAccountBalance(ata.toBase58());
}

/**
 * The Polymer prover program id, read from the on-chain `OraclePolymer`
 * account.
 *
 * `OraclePolymer` layout (oracle_polymer/src/state):
 *   discriminator[8] | polymer_prover_id: Pubkey | owner: Pubkey | chain_id u128 | bump
 *
 * The prover belongs to Polymer, not to this protocol, so its id is read
 * rather than assumed — a rotation on their side would otherwise surface as an
 * opaque CPI failure mid-proof. The result is checked against the pinned
 * constant so a change is loud rather than silent.
 */
export async function readPolymerProverId(reads: SolanaConnectionLike): Promise<string> {
  const oracle = polymerOraclePda().toBase58();
  const info = await reads.getAccountInfo(oracle);
  if (!info) {
    throw new Error(`Polymer oracle account ${oracle} does not exist on this cluster`);
  }
  if (info.data.length < 8 + 32) {
    throw new Error(`Polymer oracle account ${oracle} is too short to hold a prover id`);
  }
  let hex = "0x";
  for (const byte of info.data.subarray(8, 40)) hex += byte.toString(16).padStart(2, "0");
  const onChain = bytes32ToPubkey(hex as `0x${string}`).toBase58();
  if (onChain !== POLYMER_PROVER_PROGRAM_ID) {
    throw new Error(
      `Polymer rotated its prover program: the oracle names ${onChain}, but this build pins ${POLYMER_PROVER_PROGRAM_ID}. Update POLYMER_PROVER_PROGRAM_ID and re-verify the scratch-PDA seeds.`
    );
  }
  return onChain;
}
