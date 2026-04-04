import { keccak256 } from "viem";
import idl from "../abi/input_settler_escrow.json";
import { SOLANA_INPUT_SETTLER_ESCROW, SOLANA_POLYMER_ORACLE } from "../config";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import type { SignerWalletAdapter } from "@solana/wallet-adapter-base";
import type { Connection } from "@solana/web3.js";

const SOLANA_CONFIRMATION_TIMEOUT_MS = 60_000;

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
	walletAdapter: SignerWalletAdapter;
	connection: Connection;
}): Promise<string> {
	const { order, solanaPublicKey, walletAdapter, connection } = params;

	if (!order.inputs.length) throw new Error("StandardSolana order has no inputs");

	// Dynamic imports to avoid CJS/ESM bundling issues with Rollup
	const { AnchorProvider, BN, Program } = await import("@coral-xyz/anchor");
	const { PublicKey, SystemProgram } = await import("@solana/web3.js");
	const { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } =
		await import("@solana/spl-token");

	const userPubkey = new PublicKey(solanaPublicKey);
	const inputSettlerProgramId = new PublicKey(SOLANA_INPUT_SETTLER_ESCROW);
	const polymerProgramId = new PublicKey(SOLANA_POLYMER_ORACLE);

	// Wrap the wallet adapter as an Anchor-compatible wallet.
	// Cast through any so Transaction/VersionedTransaction generics align with Anchor's expectations.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const anchorWallet = {
		publicKey: userPubkey,
		signTransaction: (tx: any) => walletAdapter.signTransaction(tx),
		signAllTransactions: (txs: any[]) => walletAdapter.signAllTransactions(txs)
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const typedIdl = idl as any;
	const provider = new AnchorProvider(connection as any, anchorWallet as any, {
		commitment: "confirmed"
	});
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
	// Anchor's BorshCoder normalizes IDL type names to camelCase internally, so even
	// though the IDL defines this as "StandardOrder", the registry key is "standardOrder".
	let encoded: Uint8Array;
	try {
		encoded = program.coder.types.encode("standardOrder", anchorOrder);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(`Borsh encoding failed for standardOrder: ${message}`);
	}

	const orderIdHex = keccak256(encoded);
	const orderId = Buffer.from(orderIdHex.slice(2), "hex");

	// Derive orderContext PDA (seeds: ["order_context", orderId], program: SOLANA_INPUT_SETTLER_ESCROW)
	const [orderContext] = PublicKey.findProgramAddressSync(
		[Buffer.from("order_context"), orderId],
		inputSettlerProgramId
	);

	// ATA for the user (must already exist — user has a balance)
	const userTokenAccount = getAssociatedTokenAddressSync(inputMint, userPubkey, false);
	// ATA for the order PDA (created by the Anchor instruction)
	const orderPdaTokenAccount = getAssociatedTokenAddressSync(inputMint, orderContext, true);

	// Call input_settler_escrow.open(order) with a confirmation timeout.
	const signature = await Promise.race([
		program.methods
			.open(anchorOrder)
			.accounts({
				user: userPubkey,
				inputSettlerEscrow: inputSettlerEscrowPda,
				userTokenAccount,
				orderContext,
				orderPdaTokenAccount,
				mint: inputMint,
				tokenProgram: TOKEN_PROGRAM_ID,
				associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
				systemProgram: SystemProgram.programId
			})
			.rpc({ commitment: "confirmed" }),
		new Promise<never>((_, reject) =>
			setTimeout(
				() =>
					reject(
						new Error(
							`Solana transaction timed out after ${SOLANA_CONFIRMATION_TIMEOUT_MS / 1000}s`
						)
					),
				SOLANA_CONFIRMATION_TIMEOUT_MS
			)
		)
	]);

	return signature;
}
