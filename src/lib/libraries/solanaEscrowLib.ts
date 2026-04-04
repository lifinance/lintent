import { keccak256 } from "viem";
import idl from "../abi/input_settler_escrow.json";
import { SOLANA_INPUT_SETTLER_ESCROW, SOLANA_POLYMER_ORACLE } from "../config";
import type { MandateOutput, StandardSolana } from "@lifi/intent";

/** Convert a 0x-prefixed hex string (32 bytes) to a number[] */
function hexToBytes32(hex: `0x${string}`): number[] {
	return Array.from(Buffer.from(hex.slice(2), "hex"));
}

/** Convert a bigint to a 32-byte big-endian number[] */
function bigintToBeBytes32(n: bigint): number[] {
	return Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
}

/**
 * Open a Solana→EVM intent by calling input_settler_escrow.open() on Solana devnet.
 *
 * @param order           StandardSolana from @lifi/intent
 * @param solanaPublicKey Base58-encoded Solana wallet public key (becomes order.user)
 * @param walletAdapter   Connected Solana wallet adapter (Phantom, Solflare, …)
 * @param connection      Solana Connection instance
 * @returns               Solana transaction signature string
 */
export async function openSolanaEscrow(params: {
	order: StandardSolana;
	solanaPublicKey: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	walletAdapter: any; // WalletAdapter with signTransaction / signAllTransactions
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	connection: any; // Connection from @solana/web3.js
}): Promise<string> {
	// Dynamic imports to avoid CJS/ESM bundling issues with Rollup
	const { AnchorProvider, BN, Program } = await import("@coral-xyz/anchor");
	const { PublicKey, SystemProgram } = await import("@solana/web3.js");
	const {
		ASSOCIATED_TOKEN_PROGRAM_ID,
		TOKEN_PROGRAM_ID,
		TOKEN_2022_PROGRAM_ID,
		getAssociatedTokenAddressSync,
		getAccount,
		createAssociatedTokenAccountInstruction
	} = await import("@solana/spl-token");

	const { order, solanaPublicKey, walletAdapter, connection } = params;

	const userPubkey = new PublicKey(solanaPublicKey);
	const inputSettlerProgramId = new PublicKey(SOLANA_INPUT_SETTLER_ESCROW);
	const polymerProgramId = new PublicKey(SOLANA_POLYMER_ORACLE);

	// Wrap the wallet adapter as an Anchor-compatible wallet
	const anchorWallet = {
		publicKey: userPubkey,
		signTransaction: (tx: unknown) => walletAdapter.signTransaction(tx),
		signAllTransactions: (txs: unknown[]) => walletAdapter.signAllTransactions(txs)
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const typedIdl = idl as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const provider = new AnchorProvider(connection, anchorWallet as any, { commitment: "confirmed" });
	// Program converts the IDL to camelCase internally; its coder uses camelCase field names.
	// A standalone BorshCoder(rawIdl) would use snake_case names and fail to encode camelCase objects.
	const program = new Program(typedIdl, provider);

	// Derive polymer oracle PDA (seed: "polymer", program: SOLANA_POLYMER_ORACLE)
	const [polymerOraclePda] = PublicKey.findProgramAddressSync(
		[Buffer.from("polymer")],
		polymerProgramId
	);

	// Derive input settler escrow PDA (seed: "input_settler_escrow", program: SOLANA_INPUT_SETTLER_ESCROW)
	const [inputSettlerEscrowPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("input_settler_escrow")],
		inputSettlerProgramId
	);

	// Extract input token from StandardSolana.
	// Solana token IDs are full 32-byte public keys stored as bigint — do NOT use idToToken()
	// which strips the first 12 bytes (EVM-only helper that returns 20-byte addresses).
	const tokenIdHex = order.inputs[0][0].toString(16).padStart(64, "0");
	const inputMint = new PublicKey(Buffer.from(tokenIdHex, "hex"));
	const inputAmount = new BN(order.inputs[0][1].toString());

	// Build Anchor-format order.
	// Field names are camelCase here; Anchor's BorshCoder maps them to the IDL's snake_case names.
	const anchorOrder = {
		user: userPubkey,
		nonce: new BN(order.nonce.toString()),
		originChainId: new BN(order.originChainId.toString()),
		expires: order.expires,
		fillDeadline: order.fillDeadline,
		inputOracle: polymerOraclePda,
		input: { token: inputMint, amount: inputAmount },
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

	// Compute orderId = keccak256(borsh(anchorOrder)) — mirrors Rust's StandardOrder::derive_id().
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

	// Derive orderContext PDA (seeds: ["order_context", orderId], program: SOLANA_INPUT_SETTLER_ESCROW)
	const [orderContext] = PublicKey.findProgramAddressSync(
		[Buffer.from("order_context"), orderId],
		inputSettlerProgramId
	);

	// Detect whether this is a Token or Token-2022 mint by comparing owner pubkey strings
	const mintAccountInfo = await connection.getAccountInfo(inputMint);
	const isToken2022 = mintAccountInfo?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
	const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

	// ATA for the user
	const userTokenAccount = getAssociatedTokenAddressSync(
		inputMint,
		userPubkey,
		false,
		tokenProgramId
	);
	// ATA for the order PDA (created by the Anchor instruction)
	const orderPdaTokenAccount = getAssociatedTokenAddressSync(
		inputMint,
		orderContext,
		true,
		tokenProgramId
	);

	// Create the user's ATA if it doesn't exist yet
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const preInstructions: any[] = [];
	try {
		await getAccount(connection, userTokenAccount, "confirmed", tokenProgramId);
	} catch {
		preInstructions.push(
			createAssociatedTokenAccountInstruction(
				userPubkey,
				userTokenAccount,
				userPubkey,
				inputMint,
				tokenProgramId
			)
		);
	}

	// Call input_settler_escrow.open(order)
	const signature = await program.methods
		.open(anchorOrder)
		.accounts({
			user: userPubkey,
			inputSettlerEscrow: inputSettlerEscrowPda,
			userTokenAccount,
			orderContext,
			orderPdaTokenAccount,
			mint: inputMint,
			tokenProgram: tokenProgramId,
			associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
			systemProgram: SystemProgram.programId
		})
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		.preInstructions(preInstructions as any[])
		.rpc({ commitment: "confirmed" });

	return signature;
}
