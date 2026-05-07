import type { Commitment, Connection } from "@solana/web3.js";
import type { SigningWalletAdapter } from "./anchorTypes";
import inputSettlerEscrowIdl from "../abi/input_settler_escrow.json";
import { getSolanaPrograms, getSolanaNetwork } from "../config/svm";
import type { SvmOrderData } from "../../types/shared";
import { borshEncodeSolanaOrder } from "@lifi/intent";
import { toAnchorWallet } from "./anchorTypes";

async function sendSignedTransaction(params: {
  connection: Connection;
  walletAdapter: SigningWalletAdapter;
  transaction: import("@solana/web3.js").Transaction;
  signerPubkey: import("@solana/web3.js").PublicKey;
  commitment?: Commitment;
}): Promise<string> {
  const {
    connection,
    walletAdapter,
    transaction,
    signerPubkey,
    commitment = "confirmed",
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
    throw new Error(
      logs.length > 0
        ? `Solana transaction ${signature} failed: ${errJson}\n${logs.join("\n")}`
        : `Solana transaction ${signature} failed: ${errJson}`,
    );
  }

  return signature;
}

/** Borsh-encode a Vec<SolveParams> where SolveParams = { solver: [u8;32], timestamp: u32 } */
function encodeSolveParamsVec(
  params: { solver: number[]; timestamp: number }[],
): Uint8Array {
  const buf = Buffer.alloc(4 + params.length * 36);
  buf.writeUInt32LE(params.length, 0);
  let offset = 4;
  for (const sp of params) {
    for (let i = 0; i < 32; i++) buf[offset + i] = sp.solver[i];
    offset += 32;
    buf.writeUInt32LE(sp.timestamp, offset);
    offset += 4;
  }
  return buf;
}

/**
 * Derive the order_context PDA for a SvmOrderData.
 * seeds = [b"order_context", orderId]
 */
export async function deriveOrderContextPda(
  orderId: string,
  mainnet: boolean,
): Promise<string> {
  const { PublicKey } = await import("@solana/web3.js");

  const programs = getSolanaPrograms(getSolanaNetwork(mainnet));
  const inputSettlerProgramId = new PublicKey(programs.INPUT_SETTLER_ESCROW);
  const orderIdBytes = Buffer.from(orderId.replace("0x", ""), "hex");

  const [orderContextPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("order_context"), orderIdBytes],
    inputSettlerProgramId,
  );

  return orderContextPda.toBase58();
}

/**
 * Call input_settler_escrow.finalise() on Solana.
 *
 * Accepts SvmOrderData (has both base58 and bytes32 forms of addresses).
 * Encodes the order using borshEncodeSolanaOrder from @lifi/intent.
 */
export async function finaliseSolanaEscrow(params: {
  orderData: SvmOrderData;
  orderId: string; // hex orderId stored in OrderContainer
  solveParams: { solver: number[]; timestamp: number }[];
  attestationPdas: string[];
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<string> {
  const { AnchorProvider } = await import("@coral-xyz/anchor");
  const { PublicKey, SystemProgram, Transaction, TransactionInstruction } =
    await import("@solana/web3.js");
  const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
  } = await import("@solana/spl-token");

  const {
    orderData,
    orderId,
    solveParams,
    attestationPdas,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  } = params;

  const programs = getSolanaPrograms(getSolanaNetwork(mainnet));
  const solverPubkey = new PublicKey(solanaPublicKey);
  const inputSettlerProgramId = new PublicKey(programs.INPUT_SETTLER_ESCROW);
  const intentsProtocolId = new PublicKey(programs.INTENTS_PROTOCOL);

  const anchorWallet = toAnchorWallet(solverPubkey, walletAdapter);
  const provider = new AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
  });

  // Use base58 for PublicKey construction, bytes32 for borsh encoding
  const inputMint = new PublicKey(orderData.input.token);
  const userPubkey = new PublicKey(orderData.user);

  // Encode order using borshEncodeSolanaOrder — token is stored as bigint in inputs
  const orderBytes = borshEncodeSolanaOrder({
    user: orderData.userBytes32,
    nonce: orderData.nonce,
    originChainId: orderData.originChainId,
    expires: orderData.expires,
    fillDeadline: orderData.fillDeadline,
    inputOracle: orderData.inputOracleBytes32,
    inputs: [[BigInt(orderData.input.tokenBytes32), orderData.input.amount]],
    outputs: orderData.outputs,
  });

  const solveParamsBytes = encodeSolveParamsVec(solveParams);

  const idlInstructions = (
    inputSettlerEscrowIdl as {
      instructions: { name: string; discriminator: number[] }[];
    }
  ).instructions;
  const finaliseIx = idlInstructions.find((ix) => ix.name === "finalise");
  if (!finaliseIx)
    throw new Error("Could not find finalise instruction in IDL");
  const discriminator = new Uint8Array(finaliseIx.discriminator);

  const data = Buffer.concat([
    Buffer.from(discriminator),
    Buffer.from(orderBytes),
    Buffer.from(solveParamsBytes),
  ]);

  const orderIdBytes = Buffer.from(orderId.replace("0x", ""), "hex");

  const [inputSettlerEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("input_settler_escrow")],
    inputSettlerProgramId,
  );
  const [orderContext] = PublicKey.findProgramAddressSync(
    [Buffer.from("order_context"), orderIdBytes],
    inputSettlerProgramId,
  );

  const destinationTokenAccount = getAssociatedTokenAddressSync(
    inputMint,
    solverPubkey,
    false,
  );
  const orderPdaTokenAccount = getAssociatedTokenAddressSync(
    inputMint,
    orderContext,
    true,
  );

  const keys = [
    { pubkey: solverPubkey, isWritable: true, isSigner: true },
    { pubkey: inputSettlerEscrowPda, isWritable: false, isSigner: false },
    { pubkey: userPubkey, isWritable: false, isSigner: false },
    { pubkey: userPubkey, isWritable: true, isSigner: false }, // sponsor
    { pubkey: solverPubkey, isWritable: false, isSigner: false }, // destination
    { pubkey: destinationTokenAccount, isWritable: true, isSigner: false },
    { pubkey: orderContext, isWritable: true, isSigner: false },
    { pubkey: orderPdaTokenAccount, isWritable: true, isSigner: false },
    { pubkey: inputMint, isWritable: false, isSigner: false },
    { pubkey: intentsProtocolId, isWritable: false, isSigner: false },
    { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ...attestationPdas.map((pda) => ({
      pubkey: new PublicKey(pda),
      isWritable: false,
      isSigner: false,
    })),
  ];

  const ix = new TransactionInstruction({
    programId: inputSettlerProgramId,
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = solverPubkey;
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;

  const signature = await sendSignedTransaction({
    connection,
    walletAdapter,
    transaction: tx,
    signerPubkey: solverPubkey,
    commitment: "confirmed",
  });

  return signature;
}
