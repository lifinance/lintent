import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { keccak256 } from "viem";
import idl from "../abi/input_settler_escrow.json";
import { SOLANA_INPUT_SETTLER_ESCROW, SOLANA_POLYMER_ORACLE } from "../config";
import type { MandateOutput, StandardOrder } from "../../types";

/** Convert a 0x-prefixed hex string (32 bytes) to a number[] */
function hexToBytes32(hex: `0x${string}`): number[] {
	return Array.from(Buffer.from(hex.slice(2), "hex"));
}

/** Convert a bigint to a 32-byte big-endian number[] */
function bigintToBeBytes32(n: bigint): number[] {
	return Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
}

/** Recover a Solana PublicKey from a bigint (SPL mint stored as BigInt of its bytes32 hex) */
function pubkeyFromBigInt(n: bigint): PublicKey {
	return new PublicKey(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
}

/**
 * Open a Solana→EVM intent by calling input_settler_escrow.open() on Solana devnet.
 *
 * @param order           EVM-format StandardOrder from intent.ts
 *                        inputs[0] = [BigInt(bytes32SplMint), BigInt(amount)]
 * @param solanaPublicKey Base58-encoded Solana wallet public key (becomes order.user)
 * @param walletAdapter   Connected Solana wallet adapter (Phantom, Solflare, …)
 * @param connection      Solana Connection instance
 * @returns               Solana transaction signature string
 */
export async function openSolanaEscrow(params: {
	order: StandardOrder;
	solanaPublicKey: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	walletAdapter: any; // WalletAdapter with signTransaction / signAllTransactions
	connection: Connection;
}): Promise<string> {
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

	const typedIdl = idl as Idl;
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

	// Extract input token from EVM-format order:
	//   order.inputs[0] = [BigInt(bytes32SplMint), BigInt(amount)]
	const inputMint = pubkeyFromBigInt(order.inputs[0][0]);
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
	// Follows example-scripts/utils/order.ts::orderIdHash().
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

	// ATA for the user (must already exist — user has a balance)
	const userTokenAccount = getAssociatedTokenAddressSync(inputMint, userPubkey, false);
	// ATA for the order PDA (created by the Anchor instruction)
	const orderPdaTokenAccount = getAssociatedTokenAddressSync(inputMint, orderContext, true);

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
			tokenProgram: TOKEN_PROGRAM_ID,
			associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
			systemProgram: SystemProgram.programId
		})
		.rpc({ commitment: "confirmed" });

	return signature;
}
