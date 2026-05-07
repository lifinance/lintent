import { keccak256 } from "viem";
import type { Idl } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { SigningWalletAdapter } from "./anchorTypes";
import inputSettlerEscrowIdl from "../abi/input_settler_escrow.json";
import { getSolanaPrograms, getSolanaNetwork } from "../config/svm";
import type { SvmOrderData } from "../../types/shared";
import type { MandateOutput } from "@lifi/intent";
import { toAnchorWallet } from "./anchorTypes";

function hexToBytes32(hex: `0x${string}`): number[] {
  return Array.from(Buffer.from(hex.slice(2), "hex"));
}

function bigintToBeBytes32(n: bigint): number[] {
  return Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
}

/**
 * Open a Solana->EVM intent by calling input_settler_escrow.open() on Solana.
 *
 * Accepts SvmOrderData which has base58 addresses for PublicKey construction
 * and bytes32 forms for encoding.
 */
export async function openSolanaEscrow(params: {
  orderData: SvmOrderData;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<string> {
  const { AnchorProvider, BN, Program } = await import("@coral-xyz/anchor");
  const { PublicKey, SystemProgram } = await import("@solana/web3.js");
  const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
  } = await import("@solana/spl-token");

  const { orderData, solanaPublicKey, walletAdapter, connection, mainnet } =
    params;
  const programs = getSolanaPrograms(getSolanaNetwork(mainnet));

  const userPubkey = new PublicKey(solanaPublicKey);
  const inputSettlerProgramId = new PublicKey(programs.INPUT_SETTLER_ESCROW);
  const polymerProgramId = new PublicKey(programs.POLYMER_ORACLE);

  const anchorWallet = toAnchorWallet(userPubkey, walletAdapter);
  const provider = new AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  // Anchor reads `idl.address` as the runtime program ID; stamp it from the
  // active network so a devnet-bundled IDL doesn't dispatch to devnet on mainnet.
  const idl = {
    ...(inputSettlerEscrowIdl as object),
    address: programs.INPUT_SETTLER_ESCROW,
  };
  const program = new Program(idl as Idl, provider);

  const [polymerOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("polymer")],
    polymerProgramId,
  );

  const [inputSettlerEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("input_settler_escrow")],
    inputSettlerProgramId,
  );

  const inputMint = new PublicKey(orderData.input.token);
  const inputAmount = new BN(orderData.input.amount.toString());

  const anchorOrder = {
    user: userPubkey,
    nonce: new BN(orderData.nonce.toString()),
    originChainId: new BN(orderData.originChainId.toString()),
    expires: orderData.expires,
    fillDeadline: orderData.fillDeadline,
    inputOracle: polymerOraclePda,
    input: { token: inputMint, amount: inputAmount },
    outputs: orderData.outputs.map((o: MandateOutput) => ({
      oracle: hexToBytes32(o.oracle),
      settler: hexToBytes32(o.settler),
      chainId: bigintToBeBytes32(o.chainId),
      token: hexToBytes32(o.token),
      amount: bigintToBeBytes32(o.amount),
      recipient: hexToBytes32(o.recipient),
      callbackData:
        o.callbackData === "0x"
          ? Buffer.alloc(0)
          : Buffer.from(o.callbackData.slice(2), "hex"),
      context:
        o.context === "0x"
          ? Buffer.alloc(0)
          : Buffer.from(o.context.slice(2), "hex"),
    })),
  };

  const valueForEncoding = {
    ...anchorOrder,
    outputs: anchorOrder.outputs.map((o) => ({
      ...o,
      callbackData: o.callbackData ?? Buffer.alloc(0),
      context: o.context ?? Buffer.alloc(0),
    })),
  };
  let encoded: Uint8Array;
  try {
    encoded = program.coder.types.encode("standardOrder", valueForEncoding);
  } catch {
    encoded = program.coder.types.encode("StandardOrder", valueForEncoding);
  }

  const orderIdHex = keccak256(encoded);
  const orderId = Buffer.from(orderIdHex.slice(2), "hex");

  const [orderContext] = PublicKey.findProgramAddressSync(
    [Buffer.from("order_context"), orderId],
    inputSettlerProgramId,
  );

  const userTokenAccount = getAssociatedTokenAddressSync(
    inputMint,
    userPubkey,
    false,
  );
  const orderPdaTokenAccount = getAssociatedTokenAddressSync(
    inputMint,
    orderContext,
    true,
  );

  // Preflight: the Anchor `open` instruction requires the user's ATA to already
  // exist and hold at least `input.amount`. Without this check the user sees an
  // opaque `AccountNotInitialized` (no ATA) or `InsufficientFunds` (empty ATA).
  const ataInfo = await connection.getParsedAccountInfo(userTokenAccount);
  const parsed = ataInfo.value?.data;
  const parsedInfo =
    parsed && typeof parsed === "object" && "parsed" in parsed
      ? (parsed.parsed as { info?: { tokenAmount?: { amount?: string } } }).info
      : undefined;
  const ataBalance = parsedInfo?.tokenAmount?.amount
    ? BigInt(parsedInfo.tokenAmount.amount)
    : 0n;
  const required = orderData.input.amount;

  const network = mainnet ? "mainnet" : "devnet";
  if (!ataInfo.value) {
    throw new Error(
      `Your Solana ${network} wallet (${userPubkey.toBase58()}) has no ${inputMint.toBase58()} token account. ` +
        `Fund it before opening an intent.`,
    );
  }
  if (ataBalance < required) {
    throw new Error(
      `Insufficient token balance: have ${ataBalance}, need ${required} ` +
        `(mint ${inputMint.toBase58()}). Fund your Solana ${network} wallet first.`,
    );
  }

  const signature = await program.methods
    .open(anchorOrder)
    .accounts({
      sponsor: userPubkey,
      user: userPubkey,
      inputSettlerEscrow: inputSettlerEscrowPda,
      userTokenAccount,
      orderContext,
      orderPdaTokenAccount,
      mint: inputMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed", skipPreflight: true });

  return signature;
}
