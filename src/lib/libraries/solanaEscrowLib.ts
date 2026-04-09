import { keccak256 } from "viem";
import idl from "../abi/input_settler_escrow.json";
import { SOLANA_INPUT_SETTLER_ESCROW, SOLANA_POLYMER_ORACLE } from "../config";
import type { MandateOutput, StandardSolana } from "@lifi/intent";
import type { SignerWalletAdapter } from "@solana/wallet-adapter-base";
import type { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { sendAndConfirmSolanaTx } from "$lib/utils/solanaTx";

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
 * Builds the transaction via Anchor, signs it with the wallet adapter, then submits
 * it through `sendAndConfirmSolanaTx` which monitors confirmation and retries once
 * on timeout before giving up.
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
	const anchorWallet = {
		publicKey: userPubkey,
		signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) =>
			walletAdapter.signTransaction(tx),
		signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) =>
			walletAdapter.signAllTransactions(txs)
	};

	// `idl` is typed as a plain JSON object; cast to any so Anchor's Program generic accepts it.
	// `anchorWallet` is cast to any because Anchor's internal AnchorWallet type may differ across
	// peer-dependency versions of @solana/web3.js.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const provider = new AnchorProvider(connection, anchorWallet as any, {
		commitment: "confirmed"
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const typedIdl = idl as any;
	// Program converts the IDL to camelCase internally; its coder uses camelCase field names.
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
	const tokenIdHex = BigInt(order.inputs[0][0] as bigint | string | number)
		.toString(16)
		.padStart(64, "0");
	const inputMint = new PublicKey(Buffer.from(tokenIdHex, "hex"));
	const inputAmount = new BN(order.inputs[0][1].toString());

	// Build Anchor-format order (camelCase; Anchor's BorshCoder maps to IDL snake_case).
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

	// Build the transaction without sending so we can use sendAndConfirmSolanaTx.
	const tx = await program.methods
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
		.transaction();

	const { blockhash } = await connection.getLatestBlockhash("confirmed");
	tx.feePayer = userPubkey;
	tx.recentBlockhash = blockhash;

	const signedTx = await walletAdapter.signTransaction(tx);

	return sendAndConfirmSolanaTx(connection, signedTx.serialize());
}
