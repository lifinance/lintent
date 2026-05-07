import { keccak256 } from "viem";
import type { Idl } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { SigningWalletAdapter } from "./anchorTypes";
import polymerIdl from "../abi/polymer_oracle.json";
import { getSolanaPrograms, getSolanaNetwork } from "../config/svm";
import { getOutputHash, BYTES32_ZERO } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { encodeCommonPayload } from "./solanaValidate";
import type {
  SolanaFilledRecord,
  SolanaSubmittedFillRecord,
} from "../../types/shared";
import { toAnchorWallet } from "./anchorTypes";

export type { SolanaSubmittedFillRecord };

type SolanaFillContext = {
  filler: InstanceType<typeof import("@solana/web3.js").PublicKey>;
  outputSettlerPda: InstanceType<typeof import("@solana/web3.js").PublicKey>;
  polymerOraclePda: InstanceType<typeof import("@solana/web3.js").PublicKey>;
  localAttestation: InstanceType<typeof import("@solana/web3.js").PublicKey>;
  outputSettlerProgram: import("@coral-xyz/anchor").Program;
  polymerProgram: import("@coral-xyz/anchor").Program;
  intentsProtocolProgramId: InstanceType<typeof import("@solana/web3.js").PublicKey>;
  outputArg: {
    oracle: number[];
    settler: number[];
    chainId: number[];
    token: number[];
    amount: number[];
    recipient: number[];
    callbackData: Buffer;
    context: Buffer;
  };
};

const OUTPUT_SETTLER_SIMPLE_IDL_BASE = {
  metadata: { name: "outputSettlerSimple", version: "0.0.0", spec: "0.1.0" },
  instructions: [
    {
      name: "fill",
      discriminator: [168, 96, 183, 163, 92, 10, 40, 160],
      accounts: [
        { name: "filler", writable: true, signer: true },
        { name: "recipient", writable: true },
        { name: "outputSettlerSimple" },
        { name: "fillerTokenAccount", writable: true },
        { name: "recipientTokenAccount", writable: true },
        { name: "mint" },
        { name: "fillId", writable: true },
        { name: "localAttestation", writable: true },
        { name: "intentsProtocolProgram" },
        { name: "tokenProgram" },
        { name: "associatedTokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "orderId", type: { array: ["u8", 32] } },
        { name: "mandateOutput", type: { defined: { name: "mandateOutput" } } },
        { name: "fillDeadline", type: "u64" },
        { name: "fillerData", type: "bytes" },
      ],
    },
    {
      name: "nativeFill",
      discriminator: [49, 10, 255, 151, 120, 148, 73, 30],
      accounts: [
        { name: "filler", writable: true, signer: true },
        { name: "recipient", writable: true },
        { name: "outputSettlerSimple" },
        { name: "fillId", writable: true },
        { name: "localAttestation", writable: true },
        { name: "intentsProtocolProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "orderId", type: { array: ["u8", 32] } },
        { name: "mandateOutput", type: { defined: { name: "mandateOutput" } } },
        { name: "fillDeadline", type: "u64" },
        { name: "fillerData", type: "bytes" },
      ],
    },
  ],
  types: [
    {
      name: "mandateOutput",
      type: {
        kind: "struct",
        fields: [
          { name: "oracle", type: { array: ["u8", 32] } },
          { name: "settler", type: { array: ["u8", 32] } },
          { name: "chainId", type: { array: ["u8", 32] } },
          { name: "token", type: { array: ["u8", 32] } },
          { name: "amount", type: { array: ["u8", 32] } },
          { name: "recipient", type: { array: ["u8", 32] } },
          { name: "callbackData", type: "bytes" },
          { name: "context", type: "bytes" },
        ],
      },
    },
  ],
} as const;

function hexToBytes32(hex: `0x${string}`): number[] {
  return Array.from(Buffer.from(hex.slice(2), "hex"));
}

function bigintToBeBytes32(n: bigint): number[] {
  return Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
}

function encodeFillDescriptionWithoutTimestamp(
  solverBytes32: `0x${string}`,
  orderId: `0x${string}`,
  commonPayload: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from(solverBytes32.slice(2), "hex"),
    Buffer.from(orderId.slice(2), "hex"),
    commonPayload,
  ]);
}

function encodeFillDescriptionWithTimestamp(
  solverBytes32: `0x${string}`,
  orderId: `0x${string}`,
  timestamp: number,
  commonPayload: Buffer,
): Buffer {
  const ts = Buffer.alloc(4);
  ts.writeUInt32BE(timestamp >>> 0, 0);
  return Buffer.concat([
    Buffer.from(solverBytes32.slice(2), "hex"),
    Buffer.from(orderId.slice(2), "hex"),
    ts,
    commonPayload,
  ]);
}

function findProveLogIndex(logMessages: string[]): number {
  return logMessages.findIndex((entry) =>
    entry.includes("Program log: Prove: program:"),
  );
}

async function computeGlobalLogIndex(
  connection: Connection,
  slot: number,
  signature: string,
  transactionLogIndex: number,
): Promise<number> {
  const block = await connection.getBlock(slot, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
    transactionDetails: "full",
    rewards: false,
  });
  if (!block?.transactions) return transactionLogIndex;

  let logOffset = 0;
  for (const tx of block.transactions) {
    const signatures = tx.transaction.signatures as string[];
    const logMessages = tx.meta?.logMessages ?? [];
    if (signatures.includes(signature)) {
      return logOffset + transactionLogIndex;
    }
    logOffset += logMessages.length;
  }

  return transactionLogIndex;
}

async function createSolanaFillContext(params: {
  orderId: `0x${string}`;
  output: MandateOutput;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
  solverBytes32: `0x${string}`;
}): Promise<SolanaFillContext> {
  const { AnchorProvider, Program } = await import("@coral-xyz/anchor");
  const { PublicKey } = await import("@solana/web3.js");

  const {
    orderId,
    output,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
    solverBytes32,
  } = params;

  const programs = getSolanaPrograms(getSolanaNetwork(mainnet));
  const filler = new PublicKey(solanaPublicKey);
  const outputSettlerProgramId = new PublicKey(programs.OUTPUT_SETTLER_SIMPLE);
  const intentsProtocolProgramId = new PublicKey(programs.INTENTS_PROTOCOL);
  const polymerProgramId = new PublicKey(programs.POLYMER_ORACLE);

  const anchorWallet = toAnchorWallet(filler, walletAdapter);
  const provider = new AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
  });
  const outputSettlerIdl = {
    address: programs.OUTPUT_SETTLER_SIMPLE,
    ...OUTPUT_SETTLER_SIMPLE_IDL_BASE,
  };
  const outputSettlerProgram = new Program(
    outputSettlerIdl as unknown as Idl,
    provider,
  );
  const polymerIdlForNetwork = {
    ...(polymerIdl as object),
    address: programs.POLYMER_ORACLE,
  };
  const polymerProgram = new Program(polymerIdlForNetwork as Idl, provider);

  const [outputSettlerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("output_settler_simple")],
    outputSettlerProgramId,
  );
  const [polymerOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("polymer")],
    polymerProgramId,
  );
  const outputHash = Buffer.from(getOutputHash(output).slice(2), "hex");
  const [fillId] = PublicKey.findProgramAddressSync(
    [Buffer.from(orderId.slice(2), "hex"), outputHash],
    outputSettlerProgramId,
  );

  const commonPayload = encodeCommonPayload(output);
  const dataHash = Buffer.from(
    keccak256(
      encodeFillDescriptionWithoutTimestamp(
        solverBytes32,
        orderId,
        commonPayload,
      ),
    ).slice(2),
    "hex",
  );
  const [localAttestation] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("local_attestation"),
      outputSettlerPda.toBuffer(),
      Buffer.from(output.oracle.slice(2), "hex"),
      dataHash,
    ],
    intentsProtocolProgramId,
  );

  const outputArg = {
    oracle: hexToBytes32(output.oracle),
    settler: hexToBytes32(output.settler),
    chainId: bigintToBeBytes32(output.chainId),
    token: hexToBytes32(output.token),
    amount: bigintToBeBytes32(output.amount),
    recipient: hexToBytes32(output.recipient),
    callbackData:
      output.callbackData === "0x"
        ? Buffer.alloc(0)
        : Buffer.from(output.callbackData.slice(2), "hex"),
    context:
      output.context === "0x"
        ? Buffer.alloc(0)
        : Buffer.from(output.context.slice(2), "hex"),
  };

  return {
    filler,
    outputSettlerPda,
    polymerOraclePda,
    localAttestation,
    outputSettlerProgram,
    polymerProgram,
    intentsProtocolProgramId,
    outputArg,
  };
}

async function readFillTimestamp(params: {
  connection: Connection;
  localAttestation: InstanceType<typeof import("@solana/web3.js").PublicKey>;
  fillSignature: string;
}): Promise<number> {
  const { connection, localAttestation, fillSignature } = params;

  let localAttestationInfo: Awaited<
    ReturnType<typeof connection.getAccountInfo>
  > = null;
  for (const delayMs of [0, 500, 1000, 2000, 4000, 8000]) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    localAttestationInfo = await connection.getAccountInfo(
      localAttestation,
      "confirmed",
    );
    if (localAttestationInfo && localAttestationInfo.data.length >= 13) break;
  }
  if (!localAttestationInfo || localAttestationInfo.data.length < 13) {
    throw new Error(
      `Could not read Solana local attestation after fill ` +
        `(PDA ${localAttestation.toBase58()}, fill tx ${fillSignature}). ` +
        `The fill landed but the RPC has not caught up — try again in a moment.`,
    );
  }

  return localAttestationInfo.data.readUInt32LE(8);
}

export async function fillSolanaOutput(params: {
  orderId: `0x${string}`;
  output: MandateOutput;
  fillDeadline: number;
  solverBytes32: `0x${string}`;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<SolanaFilledRecord> {
  const { BN } = await import("@coral-xyz/anchor");
  const { PublicKey, SystemProgram } = await import("@solana/web3.js");
  const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
  } = await import("@solana/spl-token");

  const {
    orderId,
    output,
    fillDeadline,
    solverBytes32,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  } = params;

  const context = await createSolanaFillContext({
    orderId,
    output,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
    solverBytes32,
  });

  const {
    filler,
    outputSettlerPda,
    localAttestation,
    outputSettlerProgram,
    intentsProtocolProgramId,
    outputArg,
  } = context;

  let fillSignature: string;
  if (output.token === BYTES32_ZERO) {
    const recipient = new PublicKey(
      Buffer.from(output.recipient.slice(2), "hex"),
    );
    fillSignature = await outputSettlerProgram.methods
      .nativeFill(
        Array.from(Buffer.from(orderId.slice(2), "hex")),
        outputArg as never,
        new BN(fillDeadline),
        Buffer.from(solverBytes32.slice(2), "hex"),
      )
      .accounts({
        filler,
        recipient,
        outputSettlerSimple: outputSettlerPda,
        fillId: PublicKey.findProgramAddressSync(
          [
            Buffer.from(orderId.slice(2), "hex"),
            Buffer.from(getOutputHash(output).slice(2), "hex"),
          ],
          new PublicKey(getSolanaPrograms(getSolanaNetwork(mainnet)).OUTPUT_SETTLER_SIMPLE),
        )[0],
        localAttestation,
        intentsProtocolProgram: intentsProtocolProgramId,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
  } else {
    const recipient = new PublicKey(
      Buffer.from(output.recipient.slice(2), "hex"),
    );
    const mint = new PublicKey(Buffer.from(output.token.slice(2), "hex"));

    if (!PublicKey.isOnCurve(recipient.toBytes())) {
      throw new Error(
        `Solana output recipient (${recipient.toBase58()}) is not a valid on-curve ` +
          `Solana public key. The intent was opened without specifying a Solana ` +
          `recipient — re-open the intent and enter a Solana wallet address as the ` +
          `recipient before filling Solana outputs.`,
      );
    }

    const fillerTokenAccount = getAssociatedTokenAddressSync(
      mint,
      filler,
      false,
    );
    const recipientTokenAccount = getAssociatedTokenAddressSync(
      mint,
      recipient,
      false,
    );

    const fillerAtaInfo = await connection.getParsedAccountInfo(fillerTokenAccount);
    const fillerParsed = fillerAtaInfo.value?.data;
    const fillerParsedInfo =
      fillerParsed && typeof fillerParsed === "object" && "parsed" in fillerParsed
        ? (fillerParsed.parsed as { info?: { tokenAmount?: { amount?: string } } }).info
        : undefined;
    const fillerBalance = fillerParsedInfo?.tokenAmount?.amount
      ? BigInt(fillerParsedInfo.tokenAmount.amount)
      : 0n;
    if (!fillerAtaInfo.value) {
      throw new Error(
        `Your Solana wallet (${filler.toBase58()}) has no ${mint.toBase58()} token account. ` +
          `Fund it before filling this Solana output.`,
      );
    }
    if (fillerBalance < output.amount) {
      throw new Error(
        `Insufficient token balance to fill: have ${fillerBalance}, need ${output.amount} ` +
          `(mint ${mint.toBase58()}). Fund your Solana wallet first.`,
      );
    }

    try {
      fillSignature = await outputSettlerProgram.methods
        .fill(
          Array.from(Buffer.from(orderId.slice(2), "hex")),
          outputArg as never,
          new BN(fillDeadline),
          Buffer.from(solverBytes32.slice(2), "hex"),
        )
        .accounts({
          filler,
          recipient,
          outputSettlerSimple: outputSettlerPda,
          fillerTokenAccount,
          recipientTokenAccount,
          mint,
          fillId: PublicKey.findProgramAddressSync(
            [
              Buffer.from(orderId.slice(2), "hex"),
              Buffer.from(getOutputHash(output).slice(2), "hex"),
            ],
            new PublicKey(getSolanaPrograms(getSolanaNetwork(mainnet)).OUTPUT_SETTLER_SIMPLE),
          )[0],
          localAttestation,
          intentsProtocolProgram: intentsProtocolProgramId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });
    } catch (err) {
      const errorAny = err as {
        message?: string;
        cause?: { message?: string; logs?: string[] };
        logs?: string[];
        error?: { message?: string; logs?: string[] };
      };
      const parts: string[] = [];
      if (errorAny.message) parts.push(`message: ${errorAny.message}`);
      const causeMsg = errorAny.cause?.message ?? errorAny.error?.message;
      if (causeMsg) parts.push(`cause: ${causeMsg}`);
      const logs = errorAny.logs ?? errorAny.cause?.logs ?? errorAny.error?.logs;
      if (logs && logs.length > 0) parts.push(`logs:\n${logs.join("\n")}`);
      throw new Error(`Solana fill failed — ${parts.join(" | ") || String(err)}`);
    }
  }

  const fillTimestamp = await readFillTimestamp({
    connection,
    localAttestation,
    fillSignature,
  });

  return {
    kind: "solanaOutputFilled",
    fillSignature,
    fillTimestamp,
    solverBytes32,
    localAttestation: localAttestation.toBase58(),
    orderId,
  };
}

export async function submitFilledSolanaOutput(params: {
  record: SolanaFilledRecord;
  output: MandateOutput;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<SolanaSubmittedFillRecord> {
  const {
    record,
    output,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  } = params;

  const context = await createSolanaFillContext({
    orderId: record.orderId,
    output,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
    solverBytes32: record.solverBytes32,
  });
  const { PublicKey } = await import("@solana/web3.js");

  const commonPayload = encodeCommonPayload(output);
  const fillDescription = encodeFillDescriptionWithTimestamp(
    record.solverBytes32,
    record.orderId,
    record.fillTimestamp,
    commonPayload,
  );

  const localAttestation = new PublicKey(record.localAttestation);
  const submitSignature = await context.polymerProgram.methods
    .submit(context.outputSettlerPda, [fillDescription] as never)
    .accounts({
      submitter: context.filler,
      oraclePolymer: context.polymerOraclePda,
      intentsProtocolProgram: context.intentsProtocolProgramId,
    })
    .remainingAccounts([
      { pubkey: localAttestation, isWritable: false, isSigner: false },
    ])
    .rpc({ commitment: "confirmed", skipPreflight: true });

  let submitTx: Awaited<ReturnType<typeof connection.getTransaction>> = null;
  for (const delayMs of [0, 500, 1000, 2000, 4000, 8000]) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    submitTx = await connection.getTransaction(submitSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (submitTx?.meta?.logMessages && submitTx.slot !== undefined) break;
  }
  if (!submitTx?.meta?.logMessages || submitTx.slot === undefined) {
    throw new Error(
      `Could not load Solana polymer submit transaction logs ` +
        `(signature ${submitSignature}). The submit tx landed but the RPC has ` +
        `not indexed it — try again in a moment.`,
    );
  }
  const submitLogIndex = findProveLogIndex(submitTx.meta.logMessages);
  if (submitLogIndex === -1) {
    throw new Error(
      "Could not find Polymer prove log in Solana submit transaction",
    );
  }
  const submitGlobalLogIndex = await computeGlobalLogIndex(
    connection,
    submitTx.slot,
    submitSignature,
    submitLogIndex,
  );

  return {
    ...record,
    kind: "solanaOutputSubmittedFill",
    submitSignature,
    submitSlot: submitTx.slot,
    submitLogIndex: submitGlobalLogIndex,
  };
}

export async function fillAndSubmitSolanaOutput(params: {
  orderId: `0x${string}`;
  output: MandateOutput;
  fillDeadline: number;
  solverBytes32: `0x${string}`;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<SolanaSubmittedFillRecord> {
  const filledRecord = await fillSolanaOutput(params);
  return submitFilledSolanaOutput({
    record: filledRecord,
    output: params.output,
    solanaPublicKey: params.solanaPublicKey,
    walletAdapter: params.walletAdapter,
    connection: params.connection,
    mainnet: params.mainnet,
  });
}
