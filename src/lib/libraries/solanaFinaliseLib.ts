import idl from "../abi/input_settler_escrow.json";
import { SOLANA_INPUT_SETTLER_ESCROW, SOLANA_INTENTS_PROTOCOL } from "../config";
import type { SolanaStandardOrder } from "@lifi/intent";
import { borshEncodeSolanaOrder, computeSolanaStandardOrderId } from "@lifi/intent";

/** Borsh-encode a Vec<SolveParams> where SolveParams = { solver: [u8;32], timestamp: u32 } */
function encodeSolveParamsVec(params: { solver: number[]; timestamp: number }[]): Uint8Array {
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
 * Derive the order_context PDA for a SolanaStandardOrder.
 * Uses the canonical borsh encoding (matching the on-chain program).
 * seeds = [b"order_context", keccak256(borsh(order))]
 */
export async function deriveOrderContextPda(order: SolanaStandardOrder): Promise<string> {
	const { PublicKey } = await import("@solana/web3.js");

	const inputSettlerProgramId = new PublicKey(SOLANA_INPUT_SETTLER_ESCROW);
	const orderIdHex = computeSolanaStandardOrderId(order);
	const orderId = Buffer.from(orderIdHex.slice(2), "hex");

	const [orderContextPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("order_context"), orderId],
		inputSettlerProgramId
	);

	return orderContextPda.toBase58();
}

/**
 * Call input_settler_escrow.finalise() on Solana.
 *
 * Encodes the instruction data using the borsh library (matching the encoding
 * used by the `open` instruction) rather than Anchor's TypeScript encoder,
 * which produces different bytes and a different PDA.
 */
export async function finaliseSolanaEscrow(params: {
	order: SolanaStandardOrder;
	solveParams: { solver: number[]; timestamp: number }[];
	attestationPdas: string[];
	solanaPublicKey: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	walletAdapter: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	connection: any;
}): Promise<string> {
	const { AnchorProvider } = await import("@coral-xyz/anchor");
	const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = await import(
		"@solana/web3.js"
	);
	const { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } =
		await import("@solana/spl-token");

	const { order, solveParams, attestationPdas, solanaPublicKey, walletAdapter, connection } =
		params;

	const solverPubkey = new PublicKey(solanaPublicKey);
	const inputSettlerProgramId = new PublicKey(SOLANA_INPUT_SETTLER_ESCROW);
	const intentsProtocolId = new PublicKey(SOLANA_INTENTS_PROTOCOL);

	const anchorWallet = {
		publicKey: solverPubkey,
		signTransaction: (tx: unknown) => walletAdapter.signTransaction(tx),
		signAllTransactions: (txs: unknown[]) => walletAdapter.signAllTransactions(txs)
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const provider = new AnchorProvider(connection, anchorWallet as any, { commitment: "confirmed" });

	const inputMint = new PublicKey(Buffer.from(order.input.token.slice(2), "hex"));
	const userPubkey = new PublicKey(Buffer.from(order.user.slice(2), "hex"));

	// Encode order using the canonical borsh encoding (matches the `open` instruction)
	const orderBytes = borshEncodeSolanaOrder(order);

	// Encode solve_params using the same borsh format
	const solveParamsBytes = encodeSolveParamsVec(solveParams);

	// Instruction discriminator from the IDL
	const discriminator = new Uint8Array(
		idl.instructions.find((ix) => ix.name === "finalise")!.discriminator
	);

	// Assemble instruction data: discriminator + order + solve_params
	const data = Buffer.concat([
		Buffer.from(discriminator),
		Buffer.from(orderBytes),
		Buffer.from(solveParamsBytes)
	]);

	// Derive PDAs using the canonical orderId
	const orderIdHex = computeSolanaStandardOrderId(order);
	const orderId = Buffer.from(orderIdHex.slice(2), "hex");

	const [inputSettlerEscrowPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("input_settler_escrow")],
		inputSettlerProgramId
	);
	const [orderContext] = PublicKey.findProgramAddressSync(
		[Buffer.from("order_context"), orderId],
		inputSettlerProgramId
	);

	// ATAs
	const destinationTokenAccount = getAssociatedTokenAddressSync(inputMint, solverPubkey, false);
	const orderPdaTokenAccount = getAssociatedTokenAddressSync(inputMint, orderContext, true);

	// Build accounts list matching the IDL's finalise instruction
	const keys = [
		{ pubkey: solverPubkey, isWritable: true, isSigner: true },
		{ pubkey: inputSettlerEscrowPda, isWritable: false, isSigner: false },
		{ pubkey: userPubkey, isWritable: true, isSigner: false },
		{ pubkey: solverPubkey, isWritable: false, isSigner: false }, // destination
		{ pubkey: destinationTokenAccount, isWritable: true, isSigner: false },
		{ pubkey: orderContext, isWritable: true, isSigner: false },
		{ pubkey: orderPdaTokenAccount, isWritable: true, isSigner: false },
		{ pubkey: inputMint, isWritable: false, isSigner: false },
		{ pubkey: intentsProtocolId, isWritable: false, isSigner: false },
		{ pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
		{ pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
		{ pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
		// Remaining accounts: attestation PDAs
		...attestationPdas.map((pda) => ({
			pubkey: new PublicKey(pda),
			isWritable: false,
			isSigner: false
		}))
	];

	const ix = new TransactionInstruction({
		programId: inputSettlerProgramId,
		keys,
		data
	});

	const tx = new Transaction().add(ix);
	tx.feePayer = solverPubkey;
	tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

	const signature = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

	return signature;
}
