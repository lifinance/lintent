import { keccak256 } from "viem";
import idl from "../abi/input_settler_escrow.json";
import {
	SOLANA_INPUT_SETTLER_ESCROW,
	SOLANA_INTENTS_PROTOCOL,
	SOLANA_POLYMER_ORACLE
} from "../config";
import type { MandateOutput, SolanaStandardOrder } from "@lifi/intent";

/** Convert a 0x-prefixed hex string (32 bytes) to a number[] */
function hexToBytes32(hex: `0x${string}`): number[] {
	return Array.from(Buffer.from(hex.slice(2), "hex"));
}

/** Convert a bigint (or string/number coercible to bigint) to a 32-byte big-endian number[] */
function bigintToBeBytes32(n: bigint | string | number): number[] {
	return Array.from(Buffer.from(BigInt(n).toString(16).padStart(64, "0"), "hex"));
}

/**
 * Derive the order_context PDA for a SolanaStandardOrder.
 * orderId = keccak256(borsh(order)); seeds = [b"order_context", orderId]
 * This can be used to check if the order has been finalised (PDA closed = finalised).
 */
export async function deriveOrderContextPda(
	order: SolanaStandardOrder,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	connection: any
): Promise<string> {
	const { AnchorProvider, BN, Program } = await import("@coral-xyz/anchor");
	const { PublicKey } = await import("@solana/web3.js");

	const inputSettlerProgramId = new PublicKey(SOLANA_INPUT_SETTLER_ESCROW);
	const polymerOracleProgram = new PublicKey(SOLANA_POLYMER_ORACLE);

	const [polymerOraclePda] = PublicKey.findProgramAddressSync(
		[Buffer.from("polymer")],
		polymerOracleProgram
	);
	const inputMint = new PublicKey(Buffer.from(order.input.token.slice(2), "hex"));
	const userPubkey = new PublicKey(Buffer.from(order.user.slice(2), "hex"));

	// Dummy provider for encoding only (no wallet needed)
	const dummyWallet = {
		publicKey: userPubkey,
		signTransaction: async (tx: unknown) => tx,
		signAllTransactions: async (txs: unknown[]) => txs
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const typedIdl = idl as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const provider = new AnchorProvider(connection, dummyWallet as any, { commitment: "confirmed" });
	const program = new Program(typedIdl, provider);

	const anchorOrder = {
		user: userPubkey,
		nonce: new BN(order.nonce.toString()),
		originChainId: new BN(order.originChainId.toString()),
		expires: order.expires,
		fillDeadline: order.fillDeadline,
		inputOracle: polymerOraclePda,
		input: { token: inputMint, amount: new BN(order.input.amount.toString()) },
		outputs: order.outputs.map((o: MandateOutput) => ({
			oracle: hexToBytes32(o.oracle),
			settler: hexToBytes32(o.settler),
			chainId: bigintToBeBytes32(o.chainId),
			token: hexToBytes32(o.token),
			amount: bigintToBeBytes32(o.amount),
			recipient: hexToBytes32(o.recipient),
			callbackData:
				o.callbackData === "0x" ? Buffer.alloc(0) : Buffer.from(o.callbackData.slice(2), "hex"),
			context: o.context === "0x" ? Buffer.alloc(0) : Buffer.from(o.context.slice(2), "hex")
		}))
	};

	const valueForEncoding = {
		...anchorOrder,
		outputs: anchorOrder.outputs.map((o) => ({
			...o,
			callbackData: o.callbackData ?? Buffer.alloc(0),
			context: o.context ?? Buffer.alloc(0)
		}))
	};
	let encoded: Uint8Array;
	try {
		encoded = program.coder.types.encode("standardOrder", valueForEncoding);
	} catch {
		encoded = program.coder.types.encode("StandardOrder", valueForEncoding);
	}
	const orderIdHex = keccak256(encoded);
	const orderId = Buffer.from(orderIdHex.slice(2), "hex");

	const [orderContextPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("order_context"), orderId],
		inputSettlerProgramId
	);

	return orderContextPda.toBase58();
}

/**
 * Call input_settler_escrow.finalise() on Solana devnet.
 *
 * @param order            The SolanaStandardOrder that was previously opened
 * @param solveParams      One entry per output: solver = 32-byte Solana pubkey of the filler,
 *                         timestamp = EVM fill block timestamp
 * @param attestationPdas  Base58 pubkeys of attestation PDAs (one per output)
 * @param solanaPublicKey  Base58-encoded Solana solver public key (signer + token destination)
 * @param walletAdapter    Connected Solana wallet adapter
 * @param connection       Solana Connection instance
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
	const { AnchorProvider, BN, Program } = await import("@coral-xyz/anchor");
	const { PublicKey, SystemProgram, Transaction } = await import("@solana/web3.js");
	const { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } =
		await import("@solana/spl-token");

	const { order, solveParams, attestationPdas, solanaPublicKey, walletAdapter, connection } =
		params;

	const solverPubkey = new PublicKey(solanaPublicKey);
	const inputSettlerProgramId = new PublicKey(SOLANA_INPUT_SETTLER_ESCROW);
	const polymerOracleProgram = new PublicKey(SOLANA_POLYMER_ORACLE);
	const intentsProtocolId = new PublicKey(SOLANA_INTENTS_PROTOCOL);

	const anchorWallet = {
		publicKey: solverPubkey,
		signTransaction: (tx: unknown) => walletAdapter.signTransaction(tx),
		signAllTransactions: (txs: unknown[]) => walletAdapter.signAllTransactions(txs)
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const typedIdl = idl as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const provider = new AnchorProvider(connection, anchorWallet as any, { commitment: "confirmed" });
	const program = new Program(typedIdl, provider);

	const [polymerOraclePda] = PublicKey.findProgramAddressSync(
		[Buffer.from("polymer")],
		polymerOracleProgram
	);

	const inputMint = new PublicKey(Buffer.from(order.input.token.slice(2), "hex"));
	const userPubkey = new PublicKey(Buffer.from(order.user.slice(2), "hex"));

	const anchorOrder = {
		user: userPubkey,
		nonce: new BN(order.nonce.toString()),
		originChainId: new BN(order.originChainId.toString()),
		expires: order.expires,
		fillDeadline: order.fillDeadline,
		inputOracle: polymerOraclePda,
		input: { token: inputMint, amount: new BN(order.input.amount.toString()) },
		outputs: order.outputs.map((o: MandateOutput) => ({
			oracle: hexToBytes32(o.oracle),
			settler: hexToBytes32(o.settler),
			chainId: bigintToBeBytes32(o.chainId),
			token: hexToBytes32(o.token),
			amount: bigintToBeBytes32(o.amount),
			recipient: hexToBytes32(o.recipient),
			callbackData:
				o.callbackData === "0x" ? Buffer.alloc(0) : Buffer.from(o.callbackData.slice(2), "hex"),
			context: o.context === "0x" ? Buffer.alloc(0) : Buffer.from(o.context.slice(2), "hex")
		}))
	};

	// Compute orderId = keccak256(borsh(anchorOrder))
	const valueForEncoding = {
		...anchorOrder,
		outputs: anchorOrder.outputs.map((o) => ({
			...o,
			callbackData: o.callbackData ?? Buffer.alloc(0),
			context: o.context ?? Buffer.alloc(0)
		}))
	};
	let encoded: Uint8Array;
	try {
		encoded = program.coder.types.encode("standardOrder", valueForEncoding);
	} catch {
		encoded = program.coder.types.encode("StandardOrder", valueForEncoding);
	}
	const orderIdHex = keccak256(encoded);
	const orderId = Buffer.from(orderIdHex.slice(2), "hex");

	// Derive PDAs
	const [inputSettlerEscrowPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("input_settler_escrow")],
		inputSettlerProgramId
	);
	const [orderContext] = PublicKey.findProgramAddressSync(
		[Buffer.from("order_context"), orderId],
		inputSettlerProgramId
	);

	// ATAs: destination = solver, orderContext = escrow
	const destinationTokenAccount = getAssociatedTokenAddressSync(inputMint, solverPubkey, false);
	const orderPdaTokenAccount = getAssociatedTokenAddressSync(inputMint, orderContext, true);

	const remainingAccounts = attestationPdas.map((pda) => ({
		pubkey: new PublicKey(pda),
		isWritable: false,
		isSigner: false
	}));

	const ix = await program.methods
		.finalise(anchorOrder as any, solveParams as any)
		.accounts({
			solver: solverPubkey,
			inputSettlerEscrow: inputSettlerEscrowPda,
			user: userPubkey,
			destination: solverPubkey,
			destinationTokenAccount,
			orderContext,
			orderPdaTokenAccount,
			mint: inputMint,
			intentsProtocolProgram: intentsProtocolId,
			tokenProgram: TOKEN_PROGRAM_ID,
			associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
			systemProgram: SystemProgram.programId
		} as any)
		.remainingAccounts(remainingAccounts)
		.instruction();

	// The on-chain finalise flow closes escrow/state accounts to `user`, so `user`
	// must be writable even though the generated IDL marks it readonly.
	for (const key of ix.keys) {
		if (key.pubkey.equals(userPubkey)) key.isWritable = true;
	}

	const tx = new Transaction().add(ix);
	tx.feePayer = solverPubkey;
	tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

	const signature = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

	return signature;
}
