import {
  addressToBytes32,
  encodeFillDescription,
  encodeNotFilledDescription,
  getNotFilledDescriptionHash,
  SOLANA_MAINNET_CHAIN_ID
} from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY
} from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";
import { toChainId } from "@wormhole-foundation/sdk-base";
import { deserialize } from "@wormhole-foundation/sdk-definitions";
import type { VAA } from "@wormhole-foundation/sdk-definitions";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex } from "viem";
import {
  chainMetaById,
  COIN_FILLER,
  SOLANA_OUTPUT_SETTLER,
  SOLANA_WORMHOLE_CORE,
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_ORACLE
} from "$lib/config";
import {
  INTENTS_PROTOCOL_PROGRAM_ID,
  OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
  WORMHOLE_PROGRAM_ID
} from "$lib/idl";
import {
  decodeWormholeEnvelope,
  saveWormholeHint,
  saveWormholeMessageAccount
} from "$lib/libraries/wormholeProof";
import type { WormholePublication } from "$lib/libraries/wormholeProof";
import { SOLANA_GENESIS_HASHES, solanaRpcUrl } from "./client";
import { localAttestationDataHash } from "./encode";
import {
  buildAttestNotFilledInstruction,
  classifyLocalAttestation,
  MINT_WINDOW_MARGIN_SECS,
  NOT_FILLED_WINDOW_SECS
} from "./nonFill";
import {
  attestationPda,
  chainMappingPda,
  localAttestationPda,
  outputSettlerSimplePda,
  pubkeyToBytes32,
  SYSTEM_PROGRAM_ID,
  wormholeOraclePda
} from "./pda";
import { readChainMappingCanonicalId, readIsOutputFilled, readIsProvenOnSolana } from "./reads";
import type { SolanaAccountInfoLike, SolanaDeps, SolanaInstructionLike } from "./types";

export type PublishSolanaWormholeArgs = {
  orderId: Hex;
  output: MandateOutput;
  payload: Hex;
  timestamp: number;
  beforeSpend?: () => Promise<void>;
} & ({ kind: "fill"; solverBytes32: Hex } | { kind: "non-fill" });
export type ReceiveWormholeVaaArgs = {
  proof: Hex;
  output: MandateOutput;
  payloadHash: Hex;
  beforeSpend?: () => Promise<void>;
  onProgress?: (stage: string) => void;
};

const STATE_DISCRIMINATOR = "0xdacfeebe62a303c7";
const signatureSets = new Map<string, Keypair>();
const TIME_UNAVAILABLE = "Solana chain time unavailable. Retry with a healthy RPC.";

function requireValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** State, not program id, is both the consumer and the Wormhole emitter. */
async function deployedCore(deps: SolanaDeps): Promise<PublicKey> {
  requireValid(
    deps.chainId === BigInt(SOLANA_MAINNET_CHAIN_ID),
    "Wormhole Solana devnet is unavailable."
  );
  // Never inherit an old success when a retained facade changes its RPC transport.
  requireValid(
    (await deps.reads.getGenesisHash()) === SOLANA_GENESIS_HASHES[deps.chainId.toString()],
    "Wormhole Solana RPC serves the wrong cluster."
  );
  requireValid(
    deps.programs.wormhole.programId === WORMHOLE_PROGRAM_ID,
    "Unexpected Wormhole oracle program."
  );
  const oracle = wormholeOraclePda();
  const configured = WORMHOLE_ORACLE[Number(deps.chainId)];
  requireValid(
    !!configured && same(configured, pubkeyToBytes32(oracle)),
    "Wormhole oracle must be the configured state PDA."
  );
  const core = new PublicKey(SOLANA_WORMHOLE_CORE);
  const [state, program, coreProgram, settlerProgram, settler] = await Promise.all([
    deps.reads.getAccountInfo(oracle.toBase58(), "confirmed"),
    deps.reads.getAccountInfo(WORMHOLE_PROGRAM_ID, "confirmed"),
    deps.reads.getAccountInfo(core.toBase58(), "confirmed"),
    deps.reads.getAccountInfo(OUTPUT_SETTLER_SIMPLE_PROGRAM_ID, "confirmed"),
    deps.reads.getAccountInfo(outputSettlerSimplePda().toBase58(), "confirmed")
  ]);
  const [, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("wormhole")],
    new PublicKey(WORMHOLE_PROGRAM_ID)
  );
  requireValid(
    state?.owner === WORMHOLE_PROGRAM_ID &&
      state.data.length === 89 &&
      bytesToHex(state.data.subarray(0, 8)) === STATE_DISCRIMINATOR &&
      state.data[88] === bump,
    "Wormhole Solana oracle state owner or layout mismatch."
  );
  requireValid(
    program?.executable === true &&
      coreProgram?.executable === true &&
      settlerProgram?.executable === true &&
      settler?.owner === OUTPUT_SETTLER_SIMPLE_PROGRAM_ID,
    "Wormhole Solana programs or output settler are unavailable."
  );
  requireValid(
    new PublicKey(state.data.subarray(40, 72)).equals(core),
    "Wormhole Solana oracle Core mismatch."
  );
  let canonicalId = 0n;
  for (let i = 87; i >= 72; i--) canonicalId = (canonicalId << 8n) | BigInt(state.data[i]!);
  requireValid(canonicalId === deps.chainId, "Wormhole Solana oracle canonical chain ID mismatch.");
  return core;
}

async function mintWindow(
  deps: SolanaDeps,
  args: PublishSolanaWormholeArgs,
  mint: boolean
): Promise<void> {
  let time: number;
  try {
    time = await deps.reads.getFinalizedBlockTime();
  } catch {
    throw new Error(TIME_UNAVAILABLE);
  }
  const now = Math.floor(Date.now() / 1000);
  requireValid(Number.isInteger(time) && now - time <= MINT_WINDOW_MARGIN_SECS, TIME_UNAVAILABLE);
  requireValid(
    time > args.timestamp,
    "Solana hasn't passed the fill deadline yet. Retry in a minute."
  );
  requireValid(
    !(await readIsOutputFilled(deps.reads, args)),
    "An output was filled. Refund isn't possible."
  );
  if (mint)
    requireValid(
      Math.max(time, now) + MINT_WINDOW_MARGIN_SECS <= args.timestamp + NOT_FILLED_WINDOW_SECS,
      "Solana non-fill proofs must be created within 48h of the fill deadline."
    );
}

export async function publishSolanaWormhole(
  deps: SolanaDeps,
  args: PublishSolanaWormholeArgs
): Promise<WormholePublication> {
  requireValid(
    BigInt(args.output.chainId) === deps.chainId &&
      same(args.output.oracle, pubkeyToBytes32(wormholeOraclePda())) &&
      same(args.output.settler, SOLANA_OUTPUT_SETTLER),
    "Wormhole publication requires the output chain's state PDA and settler."
  );
  requireValid(
    Number.isInteger(args.timestamp) && args.timestamp >= 0 && args.timestamp <= 0xffffffff,
    "Wormhole proof timestamp must fit u32."
  );
  const encoded =
    args.kind === "fill"
      ? encodeFillDescription({
          orderId: args.orderId,
          output: args.output,
          solver: args.solverBytes32,
          timestamp: args.timestamp
        })
      : encodeNotFilledDescription({
          orderId: args.orderId,
          output: args.output,
          fillDeadline: args.timestamp
        });
  requireValid(
    same(encoded, args.payload),
    "Wormhole payload does not match the exact signed fill or non-fill description."
  );
  const core = await deployedCore(deps);
  const localHash =
    args.kind === "fill"
      ? localAttestationDataHash({
          orderId: args.orderId,
          output: args.output,
          solver: args.solverBytes32
        })
      : getNotFilledDescriptionHash({
          orderId: args.orderId,
          output: args.output,
          fillDeadline: args.timestamp
        });
  const localAddress = localAttestationPda(
    outputSettlerSimplePda(),
    args.output.oracle,
    localHash
  ).toBase58();
  const local = classifyLocalAttestation(
    await deps.reads.getAccountInfo(localAddress, "confirmed"),
    args.timestamp
  );
  requireValid(
    local.kind === "current" || (local.kind === "absent" && args.kind === "non-fill"),
    "Wormhole local attestation is absent, legacy or consumed. Recover its publication before retrying."
  );
  const mint = local.kind === "absent";
  if (args.kind === "non-fill") await mintWindow(deps, args, mint);
  const payer = deps.signer.publicKey;
  const message = Keypair.generate();
  const derive = (...seeds: Uint8Array[]) =>
    PublicKey.findProgramAddressSync(seeds, core)[0].toBase58();
  const submit = await deps.programs.wormhole.methods
    .submit(outputSettlerSimplePda(), [hexToBytes(args.payload)])
    .accounts({
      submitter: payer,
      oracleWormhole: wormholeOraclePda().toBase58(),
      postMessage: message.publicKey.toBase58(),
      intentsProtocolProgram: INTENTS_PROTOCOL_PROGRAM_ID,
      coreBridgeProgram: core.toBase58(),
      wormholeConfig: derive(Buffer.from("Bridge")),
      wormholeSequence: derive(Buffer.from("Sequence"), wormholeOraclePda().toBytes()),
      wormholeFeeCollector: derive(Buffer.from("fee_collector")),
      clock: SYSVAR_CLOCK_PUBKEY.toBase58(),
      rent: SYSVAR_RENT_PUBKEY.toBase58(),
      systemProgram: SYSTEM_PROGRAM_ID
    })
    .remainingAccounts([
      { pubkey: localAddress, isSigner: false, isWritable: true },
      {
        pubkey: local.kind === "current" ? local.rentRefund : payer,
        isSigner: false,
        isWritable: true
      }
    ])
    .instruction();
  const instructions = mint
    ? [
        buildAttestNotFilledInstruction({
          payer,
          orderId: args.orderId,
          output: args.output,
          fillDeadline: args.timestamp
        }),
        submit
      ]
    : [submit];
  const expected = { application: args.output.settler, payload: args.payload };
  saveWormholeMessageAccount(args.output, expected, message.publicKey.toBase58());
  const signature = await deps.signer.signAndSend(instructions, {
    additionalSigners: [message],
    beforeSign: async () => {
      if (args.kind === "non-fill") await mintWindow(deps, args, mint);
      await args.beforeSpend?.();
    }
  });
  const account = await deps.reads.getAccountInfo(message.publicKey.toBase58(), "confirmed");
  requireValid(
    account?.owner === core.toBase58(),
    "Confirmed Wormhole message account is missing or foreign-owned."
  );
  // Core's Anchor 0.29 graph must stay behind the Solana platform boundary (SSR/shared chunks use Anchor 0.31).
  const { deserializePostMessage } = await import("@wormhole-foundation/sdk-solana-core");
  const posted = deserializePostMessage(account.data);
  const envelope = decodeWormholeEnvelope(posted.payload);
  requireValid(
    bytesToHex(posted.discriminator.subarray(0, 3)) === "0x6d7367" &&
      posted.payloadLength === posted.payload.length &&
      posted.emitterChain === 1 &&
      same(bytesToHex(posted.emitterAddress.toUint8Array()), args.output.oracle) &&
      posted.nonce === 0 &&
      posted.consistencyLevel === 32 &&
      posted.timestamp >= args.timestamp &&
      same(envelope.application, expected.application) &&
      envelope.payloads.length === 1 &&
      same(envelope.payloads[0]!, args.payload),
    "Confirmed Wormhole message does not match the publication."
  );
  const publication: WormholePublication = {
    id: {
      network: "mainnet",
      emitterChain: posted.emitterChain,
      emitter: args.output.oracle,
      sequence: posted.sequence.toString()
    },
    nonce: posted.nonce,
    consistencyLevel: posted.consistencyLevel,
    txRef: signature,
    messageAccount: message.publicKey.toBase58()
  };
  saveWormholeHint(args.output, expected, publication);
  return publication;
}

/** SDK instruction builders only need account reads; keep every read on the caller's guarded RPC facade. */
function sdkConnection(deps: SolanaDeps): Connection {
  const connection = new Connection(solanaRpcUrl(deps.chainId), "confirmed");
  connection.getAccountInfo = async (address, commitment) => {
    const account = await deps.reads.getAccountInfo(
      address.toBase58(),
      commitment === "processed" || commitment === "finalized" ? commitment : "confirmed"
    );
    return account
      ? {
          owner: new PublicKey(account.owner),
          lamports: account.lamports,
          data: Buffer.from(account.data),
          executable: account.executable === true,
          rentEpoch: 0
        }
      : null;
  };
  return connection;
}
function instruction(ix: TransactionInstruction): SolanaInstructionLike {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((key) => ({ ...key, pubkey: key.pubkey.toBase58() })),
    data: ix.data
  };
}

function assertSelectedPayload(payload: Hex, output: MandateOutput): void {
  const bytes = hexToBytes(payload);
  const tag = bytesToHex(bytes.subarray(0, 4));
  const fill = tag === "0xd1252dff";
  requireValid(
    (fill || tag === "0x830c1e1c") && bytes.length >= (fill ? 172 : 140),
    "Expected a current tagged OIF proof payload."
  );
  const timestamp = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    fill ? 68 : 36,
    false
  );
  const orderId = bytesToHex(bytes.subarray(fill ? 36 : 4, fill ? 68 : 36));
  const encoded = fill
    ? encodeFillDescription({
        orderId,
        output,
        solver: bytesToHex(bytes.subarray(4, 36)),
        timestamp
      })
    : encodeNotFilledDescription({ orderId, output, fillDeadline: timestamp });
  requireValid(same(encoded, payload), "Wormhole proof does not match the exact signed output.");
}

async function postedVaaMatches(
  deps: SolanaDeps,
  address: string,
  core: PublicKey,
  vaa: VAA<"Uint8Array">
): Promise<boolean> {
  const account = await deps.reads.getAccountInfo(address, "confirmed");
  if (!account) return false;
  requireValid(account.owner === core.toBase58(), "PostedVAA is owned by an unexpected program.");
  // Lazy platform import isolates the pinned Core builders' Anchor 0.29 dependency from app SSR.
  const { deserializePostMessage } = await import("@wormhole-foundation/sdk-solana-core");
  const posted = deserializePostMessage(account.data);
  // sdk-definitions validates header version 1 but omits the fixed field from its VAA object.
  // Core's createPostVaaInstruction writes that version into the PostedVAA account.
  requireValid(
    bytesToHex(account.data.subarray(0, 3)) === "0x766161" &&
      account.data[3] === 1 &&
      new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength).getUint32(
        5,
        true
      ) === vaa.timestamp &&
      posted.nonce === vaa.nonce &&
      posted.sequence === vaa.sequence &&
      posted.emitterChain === toChainId(vaa.emitterChain) &&
      same(
        bytesToHex(posted.emitterAddress.toUint8Array()),
        bytesToHex(vaa.emitterAddress.toUint8Array())
      ) &&
      posted.consistencyLevel === vaa.consistencyLevel &&
      posted.payloadLength === vaa.payload.length &&
      same(bytesToHex(posted.payload), bytesToHex(vaa.payload)),
    "PostedVAA content does not match the signed VAA."
  );
  return true;
}

async function verifiedFlags(
  deps: SolanaDeps,
  address: string,
  core: PublicKey,
  vaa: VAA<"Uint8Array">,
  guardianCount: number
): Promise<boolean[] | null> {
  const account: SolanaAccountInfoLike = await deps.reads.getAccountInfo(address, "confirmed");
  if (!account) return null;
  requireValid(
    account.owner === core.toBase58() && account.data.length >= 40,
    "Invalid Wormhole signature-set owner or layout."
  );
  const count = new DataView(
    account.data.buffer,
    account.data.byteOffset,
    account.data.byteLength
  ).getUint32(0, true);
  requireValid(
    count === guardianCount &&
      account.data.length === 4 + count + 32 + 4 &&
      account.data.subarray(4, 4 + count).every((flag) => flag === 0 || flag === 1),
    "Invalid Wormhole signature-set flags or length."
  );
  // SDK owns signature-set decoding; byte bounds above prevent its permissive slices accepting truncation.
  const { utils } = await import("@wormhole-foundation/sdk-solana-core");
  const data = utils.SignatureSetData.deserialize(Buffer.from(account.data));
  requireValid(
    data.guardianSetIndex === vaa.guardianSet &&
      same(bytesToHex(data.hash), bytesToHex(vaa.hash)) &&
      vaa.signatures.every((signature) => signature.guardianIndex < count),
    "Wormhole signature set does not match this VAA and guardian set."
  );
  return data.signatures;
}

export async function receiveWormholeVaa(
  deps: SolanaDeps,
  args: ReceiveWormholeVaaArgs
): Promise<{ attestSignature?: string; attestation: string }> {
  const core = await deployedCore(deps);
  const nativeId = WORMHOLE_CHAIN_IDS[Number(args.output.chainId)];
  const configured = WORMHOLE_ORACLE[Number(args.output.chainId)];
  const solanaOutput = nativeId === 1;
  requireValid(
    !!nativeId &&
      !!configured &&
      chainMetaById[Number(args.output.chainId)]?.testnet === false &&
      same(args.output.oracle, solanaOutput ? configured : addressToBytes32(configured)) &&
      same(
        args.output.settler,
        solanaOutput ? SOLANA_OUTPUT_SETTLER : addressToBytes32(COIN_FILLER)
      ),
    "Wormhole output deployment or network does not match the signed output."
  );
  const vaa = deserialize("Uint8Array", hexToBytes(args.proof));
  requireValid(
    toChainId(vaa.emitterChain) === nativeId &&
      same(bytesToHex(vaa.emitterAddress.toUint8Array()), args.output.oracle) &&
      vaa.nonce === 0 &&
      vaa.consistencyLevel === (solanaOutput ? 32 : 15),
    "Wormhole VAA emitter or publication fields do not match the output."
  );
  const envelope = decodeWormholeEnvelope(vaa.payload);
  requireValid(
    same(envelope.application, args.output.settler),
    "Wormhole VAA application does not match the output settler."
  );
  const selected = envelope.payloads.find((payload) => same(keccak256(payload), args.payloadHash));
  requireValid(!!selected, "Wormhole VAA is missing the exact selected payload hash.");
  assertSelectedPayload(selected, args.output);
  const inputOracle = pubkeyToBytes32(wormholeOraclePda());
  const proofArgs = { inputOracle, output: args.output, payloadHash: args.payloadHash };
  const attestation = attestationPda(
    wormholeOraclePda(),
    args.output.chainId,
    args.output.oracle,
    args.output.settler,
    args.payloadHash
  ).toBase58();
  if (await readIsProvenOnSolana(deps.reads, proofArgs)) return { attestation };
  requireValid(
    (await readChainMappingCanonicalId(
      deps.reads,
      wormholeOraclePda().toBase58(),
      BigInt(nativeId)
    )) === BigInt(args.output.chainId),
    "Wormhole protocol-owned canonical output mapping is missing or incompatible."
  );
  // Core builders use Anchor 0.29, so load only at the Solana-specific platform boundary.
  const { utils } = await import("@wormhole-foundation/sdk-solana-core");
  const postedVaa = utils.derivePostedVaaKey(core, Buffer.from(vaa.hash)).toBase58();
  const connection = sdkConnection(deps);
  const send = async (instructions: SolanaInstructionLike[], extra?: Keypair) =>
    deps.signer.signAndSend(instructions, {
      ...(extra ? { additionalSigners: [extra] } : {}),
      beforeSign: args.beforeSpend
    });
  if (!(await postedVaaMatches(deps, postedVaa, core, vaa))) {
    requireValid(
      vaa.signatures.length > 0 && vaa.signatures.every((sig) => sig.guardianIndex < 19),
      "Wormhole VAA has no usable guardian signatures."
    );
    const key = `${deps.chainId}:${core.toBase58()}:${bytesToHex(vaa.hash)}:${deps.signer.publicKey}`;
    let signatureSet = signatureSets.get(key);
    if (!signatureSet) {
      signatureSet = Keypair.generate();
      signatureSets.set(key, signatureSet);
      args.onProgress?.(
        "Unfinished verification after a reload may incur signature-set rent again."
      );
    }
    const guardianAccount = await deps.reads.getAccountInfo(
      utils.deriveGuardianSetKey(core, vaa.guardianSet).toBase58(),
      "confirmed"
    );
    requireValid(
      guardianAccount?.owner === core.toBase58() && guardianAccount.data.length >= 16,
      "Wormhole guardian set is missing or foreign-owned."
    );
    const guardianView = new DataView(
      guardianAccount.data.buffer,
      guardianAccount.data.byteOffset,
      guardianAccount.data.byteLength
    );
    const guardianCount = guardianView.getUint32(4, true);
    requireValid(
      guardianView.getUint32(0, true) === vaa.guardianSet &&
        guardianCount > 0 &&
        guardianCount <= 19 &&
        guardianAccount.data.length === 16 + guardianCount * 20 &&
        vaa.signatures.every((signature) => signature.guardianIndex < guardianCount),
      "Wormhole guardian set or signature indices are incompatible."
    );
    const pairs = await utils.createVerifySignaturesInstructions(
      connection,
      core,
      deps.signer.publicKey,
      vaa,
      signatureSet.publicKey,
      "confirmed"
    );
    requireValid(
      pairs.length === Math.ceil(vaa.signatures.length / 7) * 2,
      "Unexpected Wormhole verification instruction batches."
    );
    for (let i = 0; i < pairs.length; i += 2) {
      const flags = await verifiedFlags(
        deps,
        signatureSet.publicKey.toBase58(),
        core,
        vaa,
        guardianCount
      );
      const batch = vaa.signatures.slice((i / 2) * 7, (i / 2 + 1) * 7);
      if (flags && batch.every((sig) => flags[sig.guardianIndex])) continue;
      args.onProgress?.("Verify guardian signatures");
      // No ComputeBudget prefix: SDK secp offsets require secp256k1 at instruction index zero.
      await send([instruction(pairs[i]!), instruction(pairs[i + 1]!)], signatureSet);
      const confirmed = await verifiedFlags(
        deps,
        signatureSet.publicKey.toBase58(),
        core,
        vaa,
        guardianCount
      );
      requireValid(
        !!confirmed && batch.every((sig) => confirmed[sig.guardianIndex]),
        "Core guardian verification did not confirm this signature batch."
      );
    }
    args.onProgress?.("Post VAA");
    await send([
      instruction(
        utils.createPostVaaInstruction(
          connection,
          core,
          deps.signer.publicKey,
          vaa,
          signatureSet.publicKey
        )
      )
    ]);
    requireValid(
      await postedVaaMatches(deps, postedVaa, core, vaa),
      "Core did not confirm the PostedVAA account."
    );
    signatureSets.delete(key);
  }
  if (await readIsProvenOnSolana(deps.reads, proofArgs)) return { attestation };
  args.onProgress?.("Register proof");
  const receive = await deps.programs.wormhole.methods
    .receive()
    .accounts({
      signer: deps.signer.publicKey,
      oracleWormhole: wormholeOraclePda().toBase58(),
      coreBridgeProgram: core.toBase58(),
      postedVaa,
      chainMapping: chainMappingPda(wormholeOraclePda(), BigInt(nativeId)).toBase58(),
      intentsProtocolProgram: INTENTS_PROTOCOL_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID
    })
    .remainingAccounts(
      envelope.payloads.map((payload) => ({
        pubkey: attestationPda(
          wormholeOraclePda(),
          args.output.chainId,
          args.output.oracle,
          envelope.application,
          keccak256(payload)
        ).toBase58(),
        isSigner: false,
        isWritable: true
      }))
    )
    .instruction();
  const attestSignature = await send([receive]);
  requireValid(
    await readIsProvenOnSolana(deps.reads, proofArgs),
    "Wormhole receive did not register the selected proof."
  );
  return { attestSignature, attestation };
}
