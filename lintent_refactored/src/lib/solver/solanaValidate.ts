import { keccak256 } from "viem";
import type { Idl } from "@coral-xyz/anchor";
import type { Commitment, Connection } from "@solana/web3.js";
import type { SigningWalletAdapter } from "./anchorTypes";
import idl from "../abi/polymer_oracle.json";
import { formatChainLabel, getSolanaPrograms, getSolanaNetwork } from "../config/svm";
import type { MandateOutput } from "@lifi/intent";
import { toAnchorWallet } from "./anchorTypes";

const POLYMER_PROVER_PROGRAM_DEVNET =
  "12dXQPJfJNJC5wDeYQMPrFvynYic7tTAGZNU7kXdBkHu";
const POLYMER_PROVER_PROGRAM_MAINNET =
  "12dXQPJfJNJC5wDeYQMPrFvynYic7tTAGZNU7kXdBkHu";

function u128ToLeBytes(n: bigint | string | number): Buffer {
  const value = BigInt(n);
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(value >> 64n, 8);
  return buf;
}

function normalizeBytes32Hex(value: `0x${string}`): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

function normalizeEvmIdentifier(
  value: `0x${string}` | undefined,
  fallbackBytes32: `0x${string}`,
): Buffer {
  if (!value) return normalizeBytes32Hex(fallbackBytes32);
  const hex = value.slice(2);
  if (hex.length === 40) return Buffer.from(hex.padStart(64, "0"), "hex");
  if (hex.length === 64) return Buffer.from(hex, "hex");
  throw new Error(`Invalid EVM identifier length: ${value.length}`);
}

async function sendSignedTransaction(params: {
  connection: Connection;
  walletAdapter: SigningWalletAdapter;
  transaction: import("@solana/web3.js").Transaction;
  signerPubkey: import("@solana/web3.js").PublicKey;
  commitment?: Commitment;
  onFailure?: (args: { signature: string; logs: string[]; errorJson: string }) => Error;
}): Promise<string> {
  const {
    connection,
    walletAdapter,
    transaction,
    signerPubkey,
    commitment = "confirmed",
    onFailure,
  } = params;

  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  transaction.feePayer = signerPubkey;
  transaction.recentBlockhash = latestBlockhash.blockhash;

  const signedTx = await walletAdapter.signTransaction(transaction);
  const rawTx = signedTx.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: true,
    maxRetries: 0,
  });

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    commitment,
  );

  if (confirmation.value.err) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    const errJson = JSON.stringify(confirmation.value.err);
    if (onFailure) {
      throw onFailure({ signature, logs, errorJson: errJson });
    }
    throw new Error(
      logs.length > 0
        ? `Solana transaction ${signature} failed: ${errJson}\n${logs.join("\n")}`
        : `Solana transaction ${signature} failed: ${errJson}`,
    );
  }

  return signature;
}

/** Encode the common payload for a MandateOutput */
export function encodeCommonPayload(output: MandateOutput): Buffer {
  const token = Buffer.from(output.token.slice(2), "hex");
  const amountHex = BigInt(output.amount).toString(16).padStart(64, "0");
  const amount = Buffer.from(amountHex, "hex");
  const recipient = Buffer.from(output.recipient.slice(2), "hex");
  const callbackData =
    output.callbackData === "0x"
      ? Buffer.alloc(0)
      : Buffer.from(output.callbackData.slice(2), "hex");
  const context =
    output.context === "0x"
      ? Buffer.alloc(0)
      : Buffer.from(output.context.slice(2), "hex");
  const callLen = Buffer.alloc(2);
  callLen.writeUInt16BE(callbackData.length, 0);
  const ctxLen = Buffer.alloc(2);
  ctxLen.writeUInt16BE(context.length, 0);
  return Buffer.concat([
    token,
    amount,
    recipient,
    callLen,
    callbackData,
    ctxLen,
    context,
  ]);
}

/** Encode fill description: solver(32) || orderId(32) || timestamp(4,BE) || commonPayload */
export function encodeFillDescription(
  solverBytes32: `0x${string}`,
  orderId: `0x${string}`,
  timestamp: number,
  commonPayload: Buffer,
): Buffer {
  const solver = Buffer.from(solverBytes32.slice(2), "hex");
  const orderIdBytes = Buffer.from(orderId.slice(2), "hex");
  const ts = Buffer.alloc(4);
  ts.writeUInt32BE(timestamp >>> 0, 0);
  return Buffer.concat([solver, orderIdBytes, ts, commonPayload]);
}

/**
 * Derive the attestation PDA for a given fill.
 * Seeds: [b"attestation", oracle_polymer_pda, evmChainId_le16, output.oracle, output.settler, payloadHash]
 * Program: SOLANA_*_INTENTS_PROTOCOL (selected via mainnet flag)
 */
export async function deriveAttestationPda(params: {
  evmChainId: bigint;
  output: MandateOutput;
  proofOutput?: MandateOutput;
  orderId: `0x${string}`;
  fillTimestamp: number;
  solverBytes32: `0x${string}`;
  emittingContract?: `0x${string}`;
  mainnet: boolean;
}): Promise<string> {
  const { PublicKey } = await import("@solana/web3.js");
  const programs = getSolanaPrograms(getSolanaNetwork(params.mainnet));
  const polymerOracleProgram = new PublicKey(programs.POLYMER_ORACLE);
  const intentsProtocol = new PublicKey(programs.INTENTS_PROTOCOL);

  const [oraclePolymerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("polymer")],
    polymerOracleProgram,
  );

  const payloadOutput = params.proofOutput ?? params.output;
  const chainIdSeed = u128ToLeBytes(params.evmChainId);
  const commonPayload = encodeCommonPayload(payloadOutput);
  const fillDesc = encodeFillDescription(
    params.solverBytes32,
    params.orderId,
    params.fillTimestamp,
    commonPayload,
  );
  const payloadHash = Buffer.from(keccak256(fillDesc).slice(2), "hex");
  const source = normalizeBytes32Hex(payloadOutput.oracle);
  const application = normalizeEvmIdentifier(
    params.emittingContract,
    payloadOutput.settler,
  );

  const [attestationPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("attestation"),
      oraclePolymerPda.toBuffer(),
      chainIdSeed,
      source,
      application,
      payloadHash,
    ],
    intentsProtocol,
  );

  return attestationPda.toBase58();
}

/**
 * Submit a Polymer proof to the Solana oracle_polymer.receive() instruction.
 * Fetches the proof from /api/polymer then calls oracle_polymer.receive().
 */
export async function submitProofToSolanaOracle(params: {
  evmChainId: bigint;
  output: MandateOutput;
  proofOutput?: MandateOutput;
  orderId: `0x${string}`;
  fillTimestamp: number;
  solverBytes32: `0x${string}`;
  emittingContract?: `0x${string}`;
  fillBlockNumber: number;
  globalLogIndex: number;
  mainnet: boolean;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
}): Promise<string> {
  const { AnchorProvider, Program } = await import("@coral-xyz/anchor");
  const { PublicKey, SystemProgram, ComputeBudgetProgram } = await import(
    "@solana/web3.js"
  );

  const network = getSolanaNetwork(params.mainnet);
  const programs = getSolanaPrograms(network);
  const signerPubkey = new PublicKey(params.solanaPublicKey);
  const polymerOracleProgram = new PublicKey(programs.POLYMER_ORACLE);
  const polymerProverProgramId = new PublicKey(
    network === "mainnet"
      ? POLYMER_PROVER_PROGRAM_MAINNET
      : POLYMER_PROVER_PROGRAM_DEVNET,
  );
  const intentsProtocolId = new PublicKey(programs.INTENTS_PROTOCOL);

  let proof: string | undefined;
  let polymerIndex: number | undefined;
  for (const waitMs of [0, 2000, 4000, 8000, 16000]) {
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    const res = await fetch("/api/polymer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        srcChainId: Number(params.evmChainId),
        srcBlockNumber: params.fillBlockNumber,
        globalLogIndex: params.globalLogIndex,
        polymerIndex,
        mainnet: params.mainnet,
      }),
    });
    const dat = (await res.json()) as {
      proof: string | undefined;
      polymerIndex: number;
    };
    polymerIndex = dat.polymerIndex;
    if (dat.proof) {
      proof = dat.proof;
      break;
    }
  }
  if (!proof) {
    throw new Error(
      "Polymer proof unavailable. Try again after the fill attestation is indexed.",
    );
  }

  const [oraclePolymerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("polymer")],
    polymerOracleProgram,
  );
  const chainIdSeed = u128ToLeBytes(params.evmChainId);

  const [chainMapping] = PublicKey.findProgramAddressSync(
    [Buffer.from("chain_mapping"), oraclePolymerPda.toBuffer(), chainIdSeed],
    intentsProtocolId,
  );
  const [cacheAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("cache"), signerPubkey.toBuffer()],
    polymerProverProgramId,
  );
  const [internalAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("internal")],
    polymerProverProgramId,
  );
  const [resultAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("result"), signerPubkey.toBuffer()],
    polymerProverProgramId,
  );

  const payloadOutput = params.proofOutput ?? params.output;
  const commonPayload = encodeCommonPayload(payloadOutput);
  const fillDesc = encodeFillDescription(
    params.solverBytes32,
    params.orderId,
    params.fillTimestamp,
    commonPayload,
  );
  const payloadHash = Buffer.from(keccak256(fillDesc).slice(2), "hex");
  const source = Buffer.from(payloadOutput.oracle.slice(2), "hex");
  const emittingContractApplication = normalizeEvmIdentifier(
    params.emittingContract,
    payloadOutput.settler,
  );

  const [attestationPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("attestation"),
      oraclePolymerPda.toBuffer(),
      chainIdSeed,
      source,
      emittingContractApplication,
      payloadHash,
    ],
    intentsProtocolId,
  );

  const anchorWallet = toAnchorWallet(signerPubkey, params.walletAdapter);
  const provider = new AnchorProvider(params.connection, anchorWallet, {
    commitment: "confirmed",
  });
  // Stamp `address` so the bundled (devnet-addressed) IDL targets the active
  // network's polymer program at runtime.
  const polymerIdlForNetwork = {
    ...(idl as object),
    address: programs.POLYMER_ORACLE,
  };
  const program = new Program(polymerIdlForNetwork as Idl, provider);

  const proofBytes = Buffer.from(proof, "hex");
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  const methodBuilder = program.methods
    .receive([proofBytes] as never)
    .accounts({
      signer: signerPubkey,
      oraclePolymer: oraclePolymerPda,
      polymerProverProgram: polymerProverProgramId,
      chainMapping,
      cacheAccount,
      internal: internalAccount,
      resultAccount,
      intentsProtocolProgram: intentsProtocolId,
      systemProgram: SystemProgram.programId,
    } as never)
    .remainingAccounts([
      { pubkey: attestationPda, isWritable: true, isSigner: false },
    ])
    .preInstructions([computeIx]);

  // Skip preflight: this RPC's simulation lags the live cluster and reports
  // false-negative errors (e.g. UnsupportedProgramId when the prover state
  // hasn't yet propagated). Send with skipPreflight and retry on real
  // confirmation failures — the tx will succeed once the prover is caught up.
  const delays = [0, 10_000, 20_000, 40_000, 60_000];
  let lastError: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      const tx = await methodBuilder.transaction();
      return await sendSignedTransaction({
        connection: params.connection,
        walletAdapter: params.walletAdapter,
        transaction: tx,
        signerPubkey,
        commitment: "confirmed",
        onFailure: ({ signature, logs, errorJson }) => {
          const chainMappingMissing = logs.some((log) =>
            log.includes("account: chain_mapping") &&
            log.includes("AccountNotInitialized"),
          );
          if (chainMappingMissing) {
            return new Error(
              `Solana Polymer oracle ${programs.POLYMER_ORACLE} is missing the chain mapping for ` +
                `${formatChainLabel(params.evmChainId)}. ` +
                `Initialize set_chain_mapping for protocol_chain_id=${params.evmChainId.toString()} ` +
                `at chain_mapping PDA ${chainMapping.toBase58()} on the oracle, then retry validation. ` +
                `(tx ${signature})`,
            );
          }
          return new Error(
            logs.length > 0
              ? `Solana transaction ${signature} failed: ${errorJson}\n${logs.join("\n")}`
              : `Solana transaction ${signature} failed: ${errorJson}`,
          );
        },
      });
    } catch (err) {
      lastError = err;
      if (i === delays.length - 1) break;
      const next = delays[i + 1];
      console.warn(
        `Polymer receive failed on chain, retrying in ${next / 1000}s…`,
        err,
      );
    }
  }
  throw new Error(
    `Polymer proof not yet accepted by the Solana prover. Please try again in a few minutes. (${
      lastError instanceof Error ? lastError.message : String(lastError)
    })`,
  );
}
