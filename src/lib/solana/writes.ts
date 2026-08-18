// Solana write paths: open, fill, submit, receive, finalise.
//
// Every function takes `SolanaDeps` first and touches the chain only through
// it, so the whole layer is testable against a hand-built mock. Each one
// asserts the cluster before signing — the guard belongs here rather than in
// the UI, because the cluster comes from the order and the UI is exactly what
// gets it wrong.

import { getOutputHash } from "@lifi/intent";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import { INTENTS_PROTOCOL_PROGRAM_ID, POLYMER_PROGRAM_ID } from "$lib/idl";
import { assertSolanaCluster } from "./client";
import {
  assertSolanaAmountFitsU64,
  fillPayloadHash,
  isNativeSolanaOutput,
  localAttestationDataHash,
  solverToFillerData
} from "./encode";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  attestationPda,
  bytes32ToPubkey,
  chainMappingPda,
  consumedOrderPda,
  fillIdPda,
  inputSettlerEscrowPda,
  localAttestationPda,
  orderContextPda,
  outputSettlerSimplePda,
  polymerOraclePda
} from "./pda";
import type { SolanaConnectionLike, SolanaDeps, SolanaInstructionLike } from "./types";

/** `receive_attest` verifies a proof by CPI and needs well above the 200k default. */
const RECEIVE_ATTEST_COMPUTE_UNITS = 1_000_000;

/**
 * Lazily-loaded Anchor argument codecs.
 *
 * Loaded on demand so `@solana/web3.js` and Anchor stay out of the main chunk;
 * this module is imported eagerly by the solver, the SDKs are not.
 */
async function codecs() {
  const [web3, anchor] = await Promise.all([
    import("@solana/web3.js"),
    import("@coral-xyz/anchor")
  ]);
  return { PublicKey: web3.PublicKey, BN: anchor.BN };
}

type Codecs = Awaited<ReturnType<typeof codecs>>;

/**
 * bytes32 hex → the `[u8; 32]` Anchor expects.
 *
 * Validated rather than trusted: the loop below reads exactly 32 bytes, so a
 * short, odd-length or non-hex value (a base58 Solana address, say) would fill
 * the tail with `NaN` — borsh-encoded as zeroes — and produce an instruction
 * argument that disagrees with the PDAs the client derived from the same field.
 * That surfaces on chain as an opaque `ConstraintSeeds`, so it is rejected
 * here instead.
 */
function bytes32Array(value: `0x${string}`): number[] {
  const hex = value.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Expected 32-byte hex for a Solana instruction argument, got ${value}`);
  }
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function toAnchorOutput(output: MandateOutput) {
  return {
    oracle: bytes32Array(output.oracle),
    settler: bytes32Array(output.settler),
    chainId: bytes32Array(toBytes32(output.chainId)),
    token: bytes32Array(output.token),
    amount: bytes32Array(toBytes32(output.amount)),
    recipient: bytes32Array(output.recipient),
    callbackData: Buffer.from(output.callbackData.replace(/^0x/, ""), "hex"),
    context: Buffer.from(output.context.replace(/^0x/, ""), "hex")
  };
}

/**
 * A numeric order field → 32-byte big-endian hex.
 *
 * `BigInt(value)` is not redundant despite the `bigint` type: orders are
 * persisted with `JSON.stringify` under the `BigInt.prototype.toJSON` polyfill
 * and read back with a plain `JSON.parse`, so every amount and chain id in a
 * container that has been through the local DB is a decimal STRING at runtime.
 * `String.prototype.toString` ignores its radix argument, so the unguarded
 * version re-read those decimal digits as hex — amount `1496250` became
 * `0x…01496250` (21,455,440) and chain id `1151111081099710` became
 * `0x…1151111081099710`.
 *
 * Only the instruction arguments went through here; the fill's PDAs are seeded
 * off `getOutputHash`, which coerces through viem and stayed correct. So the
 * client asked the program to derive `fill_id` from a different mandate-output
 * hash than the one it had derived itself, and the fill died in `try_accounts`
 * with `ConstraintSeeds` (2006 / 0x7d6) — before `validate_chain_id_is_output_chain_id`
 * could name the real problem. Had the seeds happened to line up, the SPL
 * transfer would have moved 21.455440 USDC instead of 1.496250.
 */
function toBytes32(value: bigint): `0x${string}` {
  const asBigInt = BigInt(value);
  if (asBigInt < 0n || asBigInt >= 1n << 256n) {
    throw new Error(`Value ${asBigInt} does not fit in bytes32`);
  }
  return `0x${asBigInt.toString(16).padStart(64, "0")}`;
}

function toAnchorOrder(order: StandardSolana, c: Codecs) {
  const { PublicKey, BN } = c;
  const [input] = order.inputs;
  if (!input) throw new Error("A Solana order must have exactly one input");
  const [token, amount] = input;
  return {
    user: new PublicKey(bytes32ToPubkey(order.user as `0x${string}`).toBytes()),
    nonce: new BN(order.nonce.toString()),
    originChainId: new BN(order.originChainId.toString()),
    expires: order.expires,
    fillDeadline: order.fillDeadline,
    inputOracle: new PublicKey(bytes32ToPubkey(order.inputOracle).toBytes()),
    input: {
      token: new PublicKey(bytes32ToPubkey(toBytes32(token)).toBytes()),
      amount: new BN(amount.toString())
    },
    outputs: order.outputs.map(toAnchorOutput)
  };
}

/**
 * The program that owns `mint`.
 *
 * The settlers accept SPL and Token-2022 through Anchor's `TokenInterface`,
 * but the owning program is part of the associated-token-account seed, so
 * guessing it derives an ATA the program will reject. Read it.
 */
async function tokenProgramForMint(
  reads: SolanaConnectionLike,
  mintBase58: string
): Promise<string> {
  const info = await reads.getAccountInfo(mintBase58);
  if (!info) throw new Error(`Mint ${mintBase58} does not exist on this cluster`);
  if (info.owner !== TOKEN_PROGRAM_ID && info.owner !== TOKEN_2022_PROGRAM_ID) {
    throw new Error(`Mint ${mintBase58} is owned by ${info.owner}, which is not a token program`);
  }
  return info.owner;
}

/**
 * Opens the escrow for a Solana-input order.
 *
 * There is no approval step: `open` debits the user's ATA under the user's own
 * signature, so nothing corresponding to an ERC-20 allowance exists — which is
 * why `escrowApprove` no-ops for Solana rather than doing something clever.
 */
export async function openEscrow(
  deps: SolanaDeps,
  args: { order: StandardSolana; orderId: `0x${string}` }
): Promise<string> {
  await assertSolanaCluster(deps.chainId, deps.reads);
  const c = await codecs();
  const { order, orderId } = args;

  const [input] = order.inputs;
  if (!input) throw new Error("A Solana order must have exactly one input");
  const [tokenId] = input;
  const mint = bytes32ToPubkey(toBytes32(tokenId));
  if (tokenId === 0n) {
    throw new Error(
      "Solana escrow has no native-SOL input path; `open` requires an SPL mint. Use a wrapped-SOL mint instead."
    );
  }

  // The escrow pulls from the user's ATA under the user's signature, so the
  // connected wallet must BE the order's user — signing for someone else
  // silently produces a transaction that cannot succeed.
  const user = bytes32ToPubkey(order.user as `0x${string}`).toBase58();
  if (deps.signer.publicKey !== user) {
    throw new Error(
      `Connected wallet ${deps.signer.publicKey} is not the order's user ${user}; it cannot open this escrow`
    );
  }

  const tokenProgram = await tokenProgramForMint(deps.reads, mint.toBase58());
  const orderContext = orderContextPda(orderId);

  const instruction = await deps.programs.inputSettlerEscrow.methods
    .open(toAnchorOrder(order, c))
    .accounts({
      sponsor: deps.signer.publicKey,
      user,
      inputSettlerEscrow: inputSettlerEscrowPda().toBase58(),
      userTokenAccount: associatedTokenAddress(mint.toBase58(), user, tokenProgram).toBase58(),
      orderContext: orderContext.toBase58(),
      consumedOrder: consumedOrderPda(orderId).toBase58(),
      // The escrow vault: the order context PDA's own ATA for the input mint.
      orderPdaTokenAccount: associatedTokenAddress(
        mint.toBase58(),
        orderContext.toBase58(),
        tokenProgram
      ).toBase58(),
      mint: mint.toBase58(),
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID
    })
    .instruction();

  return deps.signer.signAndSend([instruction]);
}

/**
 * Fills one output.
 *
 * The settler takes a single `MandateOutput` per instruction — there is no
 * batch equivalent of the EVM `fillOrderOutputs` — so a multi-output fill is
 * several instructions, and the caller decides how to group them.
 */
export async function fillOutput(
  deps: SolanaDeps,
  args: {
    orderId: `0x${string}`;
    output: MandateOutput;
    fillDeadline: number;
    solverBytes32: `0x${string}`;
  }
): Promise<string> {
  return fillOutputs(deps, { ...args, outputs: [args.output] });
}

/**
 * Fills several outputs in ONE transaction.
 *
 * The settler takes a single `MandateOutput` per instruction — there is no
 * batch equivalent of the EVM `fillOrderOutputs` — but the instructions can
 * share a transaction, and they must: the caller stores one transaction
 * reference per output, and solver/timestamp are later recovered by searching
 * that transaction's logs for each output's `OutputFilledEvent`. Filling
 * across separate transactions would leave outputs 2..N pointing at a
 * transaction that does not contain their event — they would be filled and
 * then unprovable.
 *
 * Transactions are capped at 1232 bytes, so a large group will not fit; that
 * surfaces as a send failure from the RPC rather than being silently split.
 */
export async function fillOutputs(
  deps: SolanaDeps,
  args: {
    orderId: `0x${string}`;
    outputs: MandateOutput[];
    fillDeadline: number;
    solverBytes32: `0x${string}`;
  }
): Promise<string> {
  await assertSolanaCluster(deps.chainId, deps.reads);
  if (args.outputs.length === 0) throw new Error("fillOutputs requires at least one output");
  const instructions: SolanaInstructionLike[] = [];
  for (const output of args.outputs) {
    instructions.push(await buildFillInstruction(deps, { ...args, output }));
  }
  return deps.signer.signAndSend(instructions);
}

async function buildFillInstruction(
  deps: SolanaDeps,
  args: {
    orderId: `0x${string}`;
    output: MandateOutput;
    fillDeadline: number;
    solverBytes32: `0x${string}`;
  }
): Promise<SolanaInstructionLike> {
  const c = await codecs();
  const { orderId, output, fillDeadline, solverBytes32 } = args;

  assertSolanaAmountFitsU64(output);
  if (output.callbackData !== "0x") {
    throw new Error("The Solana output settler does not support callbackData");
  }
  const fillerData = solverToFillerData(solverBytes32);

  const recipient = bytes32ToPubkey(output.recipient).toBase58();
  const fillId = fillIdPda(orderId, getOutputHash(output));
  // Created by CPI into the protocol; the client must derive and pass it,
  // because the IDL cannot express a seed that is a hash of an argument.
  const localAttestation = localAttestationPda(
    outputSettlerSimplePda(),
    output.oracle,
    localAttestationDataHash({ solver: solverBytes32, orderId, output })
  );

  const settlerPda = outputSettlerSimplePda().toBase58();
  const common = {
    filler: deps.signer.publicKey,
    recipient,
    outputSettlerSimple: settlerPda,
    fillId: fillId.toBase58(),
    localAttestation: localAttestation.toBase58(),
    intentsProtocolProgram: INTENTS_PROTOCOL_PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM_ID
  };

  const anchorOutput = toAnchorOutput(output);
  const deadline = new c.BN(fillDeadline);

  const instruction = isNativeSolanaOutput(output)
    ? await deps.programs.outputSettlerSimple.methods
        .nativeFill(bytes32Array(orderId), anchorOutput, deadline, Buffer.from(fillerData))
        .accounts(common)
        .instruction()
    : await (async () => {
        const mint = bytes32ToPubkey(output.token);
        const tokenProgram = await tokenProgramForMint(deps.reads, mint.toBase58());
        return deps.programs.outputSettlerSimple.methods
          .fill(bytes32Array(orderId), anchorOutput, deadline, Buffer.from(fillerData))
          .accounts({
            ...common,
            fillerTokenAccount: associatedTokenAddress(
              mint.toBase58(),
              deps.signer.publicKey,
              tokenProgram
            ).toBase58(),
            recipientTokenAccount: associatedTokenAddress(
              mint.toBase58(),
              recipient,
              tokenProgram
            ).toBase58(),
            mint: mint.toBase58(),
            tokenProgram,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID
          })
          .instruction();
      })();

  return instruction;
}

/**
 * Submits a filled output to Polymer, producing the `Prove:` log its indexer
 * reads.
 *
 * `source` is the output settler PDA, and it becomes `application` on the EVM
 * side. The output's own oracle must be the Polymer PROGRAM ID: `submit`
 * compares it against `ctx.program_id`, so an order naming the oracle PDA
 * instead fills fine and then cannot be proven. Checked up front so that shows
 * up as a legible error rather than a revert.
 */
export async function submitFillProof(
  deps: SolanaDeps,
  args: {
    orderId: `0x${string}`;
    output: MandateOutput;
    solverBytes32: `0x${string}`;
    timestamp: number;
  }
): Promise<string> {
  await assertSolanaCluster(deps.chainId, deps.reads);
  const c = await codecs();
  const { orderId, output, solverBytes32, timestamp } = args;

  const expectedOracle = bytes32ToPubkey(output.oracle).toBase58();
  if (expectedOracle !== POLYMER_PROGRAM_ID) {
    throw new Error(
      `This output names oracle ${expectedOracle}; Polymer can only prove outputs whose oracle is the Polymer program ${POLYMER_PROGRAM_ID}`
    );
  }

  const { encodeFillDescription } = await import("@lifi/intent");
  const payload = encodeFillDescription({ solver: solverBytes32, orderId, timestamp, output });

  const localAttestation = localAttestationPda(
    outputSettlerSimplePda(),
    output.oracle,
    localAttestationDataHash({ solver: solverBytes32, orderId, output })
  );

  const instruction = await deps.programs.polymer.methods
    .submit(new c.PublicKey(outputSettlerSimplePda().toBytes()), [
      Buffer.from(payload.replace(/^0x/, ""), "hex")
    ])
    .accounts({
      submitter: deps.signer.publicKey,
      oraclePolymer: polymerOraclePda().toBase58(),
      intentsProtocolProgram: INTENTS_PROTOCOL_PROGRAM_ID
    })
    .remainingAccounts([
      { pubkey: localAttestation.toBase58(), isSigner: false, isWritable: false }
    ])
    .instruction();

  return deps.signer.signAndSend([instruction]);
}

/**
 * Verifies a Polymer proof on Solana and writes the attestation `finalise`
 * will read.
 *
 * Two transactions, because that is why the program splits the steps: the
 * prover CPI plus the attestation exceed one transaction's compute and size
 * budget. Idempotent — if the attestation already exists there is nothing to
 * do, and re-running would only waste a signature.
 */
export async function receiveProof(
  deps: SolanaDeps,
  args: {
    proof: Uint8Array;
    orderId: `0x${string}`;
    output: MandateOutput;
    solverBytes32: `0x${string}`;
    timestamp: number;
    proverProgramId: string;
    proverAccounts: { cache: string; result: string; internal: string };
  }
): Promise<{ loadSignature?: string; attestSignature?: string; attestation: string }> {
  await assertSolanaCluster(deps.chainId, deps.reads);

  const payloadHash = fillPayloadHash({
    solver: args.solverBytes32,
    orderId: args.orderId,
    timestamp: args.timestamp,
    output: args.output
  });
  const attestation = attestationPda(
    polymerOraclePda(),
    args.output.chainId,
    args.output.oracle,
    args.output.settler,
    payloadHash
  );

  const existing = await deps.reads.getAccountInfo(attestation.toBase58());
  if (existing?.owner === INTENTS_PROTOCOL_PROGRAM_ID) {
    return { attestation: attestation.toBase58() };
  }

  const oracle = polymerOraclePda().toBase58();
  const proverCommon = {
    signer: deps.signer.publicKey,
    oraclePolymer: oracle,
    polymerProverProgram: args.proverProgramId,
    cacheAccount: args.proverAccounts.cache,
    internal: args.proverAccounts.internal,
    resultAccount: args.proverAccounts.result,
    systemProgram: SYSTEM_PROGRAM_ID
  };

  const loadIx = await deps.programs.polymer.methods
    .receiveLoadProof(Buffer.from(args.proof))
    .accounts(proverCommon)
    .instruction();
  const loadSignature = await deps.signer.signAndSend([loadIx], {
    computeUnitLimit: RECEIVE_ATTEST_COMPUTE_UNITS
  });

  const chainMapping = chainMappingPda(polymerOraclePda(), args.output.chainId);
  const attestIx = await deps.programs.polymer.methods
    .receiveAttest()
    .accounts({
      signer: deps.signer.publicKey,
      oraclePolymer: oracle,
      polymerProverProgram: args.proverProgramId,
      chainMapping: chainMapping.toBase58(),
      cacheAccount: args.proverAccounts.cache,
      internal: args.proverAccounts.internal,
      resultAccount: args.proverAccounts.result,
      attestation: attestation.toBase58(),
      intentsProtocolProgram: INTENTS_PROTOCOL_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID
    })
    .instruction();
  const attestSignature = await deps.signer.signAndSend([attestIx], {
    computeUnitLimit: RECEIVE_ATTEST_COMPUTE_UNITS
  });

  return { loadSignature, attestSignature, attestation: attestation.toBase58() };
}

/**
 * Finalises a Solana-input order, releasing the escrow to the solver.
 *
 * `remainingAccounts` carries one attestation per output IN `order.outputs`
 * ORDER — the program indexes them positionally, so a reordering settles the
 * wrong output. Same-chain outputs use a LocalAttestation, remote ones the
 * oracle-written Attestation.
 */
export async function finalise(
  deps: SolanaDeps,
  args: {
    order: StandardSolana;
    orderId: `0x${string}`;
    solveParams: { timestamp: number; solver: `0x${string}` }[];
    destinationBytes32: `0x${string}`;
  }
): Promise<string> {
  await assertSolanaCluster(deps.chainId, deps.reads);
  const c = await codecs();
  const { order, orderId, solveParams, destinationBytes32 } = args;

  const first = solveParams[0];
  if (!first) throw new Error("finalise requires at least one solve param");

  // The program requires solve_params[0].solver to sign. Check before building
  // the transaction so the wrong wallet gets a sentence, not a program error.
  const requiredSigner = bytes32ToPubkey(first.solver).toBase58();
  if (deps.signer.publicKey !== requiredSigner) {
    throw new Error(
      `finalise must be signed by the first solver ${requiredSigner}, but the connected wallet is ${deps.signer.publicKey}`
    );
  }

  const orderContext = orderContextPda(orderId);
  // `sponsor` is whoever paid the rent at open, which need not be the user.
  // It is stored on the order context and reclaimed there, so read it back
  // rather than assuming.
  const contextInfo = await deps.reads.getAccountInfo(orderContext.toBase58());
  if (!contextInfo) {
    throw new Error(`Order ${orderId} has no open escrow on Solana; it may already be settled`);
  }

  const [input] = order.inputs;
  if (!input) throw new Error("A Solana order must have exactly one input");
  const mint = bytes32ToPubkey(toBytes32(input[0]));
  const tokenProgram = await tokenProgramForMint(deps.reads, mint.toBase58());
  const destination = bytes32ToPubkey(destinationBytes32).toBase58();
  const user = bytes32ToPubkey(order.user as `0x${string}`).toBase58();

  const remaining = order.outputs.map((output, index) => {
    const params = solveParams[index] ?? first;
    // Compared as bigints, not with `===`: a container reloaded from the local
    // DB carries these as decimal strings (see `toBytes32`), and a string/bigint
    // pair is never `===`. That silently classified a same-chain output as
    // remote and put the wrong attestation account in `remainingAccounts`.
    const sameChain = BigInt(output.chainId) === BigInt(order.originChainId);
    const pubkey = sameChain
      ? localAttestationPda(
          outputSettlerSimplePda(),
          output.oracle,
          localAttestationDataHash({ solver: params.solver, orderId, output })
        )
      : attestationPda(
          bytes32ToPubkey(order.inputOracle),
          output.chainId,
          output.oracle,
          output.settler,
          fillPayloadHash({
            solver: params.solver,
            orderId,
            timestamp: params.timestamp,
            output
          })
        );
    return { pubkey: pubkey.toBase58(), isSigner: false, isWritable: false };
  });

  const instruction = await deps.programs.inputSettlerEscrow.methods
    .finalise(
      toAnchorOrder(order, c),
      solveParams.map((param) => ({
        solver: bytes32Array(param.solver),
        timestamp: param.timestamp
      }))
    )
    .accounts({
      solver: deps.signer.publicKey,
      inputSettlerEscrow: inputSettlerEscrowPda().toBase58(),
      user,
      sponsor: readSponsor(contextInfo.data, user),
      destination,
      destinationTokenAccount: associatedTokenAddress(
        mint.toBase58(),
        destination,
        tokenProgram
      ).toBase58(),
      orderContext: orderContext.toBase58(),
      orderPdaTokenAccount: associatedTokenAddress(
        mint.toBase58(),
        orderContext.toBase58(),
        tokenProgram
      ).toBase58(),
      mint: mint.toBase58(),
      intentsProtocolProgram: INTENTS_PROTOCOL_PROGRAM_ID,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID
    })
    .remainingAccounts(remaining)
    .instruction();

  return deps.signer.signAndSend([instruction]);
}

/**
 * Reads `sponsor` out of a raw OrderContext account.
 *
 * Layout (input_settler_escrow/src/state/input_settler_escrow.rs):
 *   discriminator[8] | input_token: Pubkey | user: Pubkey | sponsor: Pubkey | bump
 * so `sponsor` starts at byte 72, NOT immediately after the discriminator.
 *
 * The sponsor is whoever paid the rent at open — often but not always the
 * user — and `finalise` refunds the closed account to it under a
 * `has_one = sponsor` constraint, so reading the wrong offset makes every
 * claim fail. Decoded by hand rather than through the Anchor account coder so
 * this stays on the DI seam and tests can supply plain bytes.
 */
const ORDER_CONTEXT_SPONSOR_OFFSET = 8 + 32 + 32;

function readSponsor(data: Uint8Array, fallback: string): string {
  const end = ORDER_CONTEXT_SPONSOR_OFFSET + 32;
  if (data.length < end) return fallback;
  const bytes = data.subarray(ORDER_CONTEXT_SPONSOR_OFFSET, end);
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return bytes32ToPubkey(hex as `0x${string}`).toBase58();
}
