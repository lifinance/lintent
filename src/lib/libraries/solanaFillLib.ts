import { keccak256 } from "viem";
import polymerIdl from "../abi/polymer.json";
import outputSettlerIdl from "../abi/output_settler_simple.json";
import {
	SOLANA_INTENTS_PROTOCOL,
	SOLANA_OUTPUT_SETTLER_SIMPLE,
	SOLANA_POLYMER_ORACLE,
	BYTES32_ZERO
} from "../config";
import { encodeCommonPayload } from "./solanaValidateLib";
import type { MandateOutput } from "@lifi/intent";
import { getOutputHash } from "@lifi/intent";
import type { SignerWalletAdapter } from "@solana/wallet-adapter-base";
import type { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { sendAndConfirmSolanaTx } from "$lib/utils/solanaTx";

export type SolanaSubmittedFillRecord = {
	kind: "solanaOutputSubmittedFill";
	fillSignature: string;
	submitSignature: string;
	fillTimestamp: number;
	solverBytes32: `0x${string}`;
	localAttestation: string;
	submitSlot: number;
	submitLogIndex: number;
	orderId: `0x${string}`;
};

export function isSolanaSubmittedFillRecord(value: unknown): value is SolanaSubmittedFillRecord {
	if (!value || typeof value !== "object") return false;
	return (value as { kind?: string }).kind === "solanaOutputSubmittedFill";
}

function hexToBytes32(hex: `0x${string}`): number[] {
	return Array.from(Buffer.from(hex.slice(2), "hex"));
}

function bigintToBeBytes32(n: bigint): number[] {
	return Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
}

function encodeFillDescriptionWithoutTimestamp(
	solverBytes32: `0x${string}`,
	orderId: `0x${string}`,
	commonPayload: Buffer
): Buffer {
	return Buffer.concat([
		Buffer.from(solverBytes32.slice(2), "hex"),
		Buffer.from(orderId.slice(2), "hex"),
		commonPayload
	]);
}

function encodeFillDescriptionWithTimestamp(
	solverBytes32: `0x${string}`,
	orderId: `0x${string}`,
	timestamp: number,
	commonPayload: Buffer
): Buffer {
	const ts = Buffer.alloc(4);
	ts.writeUInt32BE(timestamp >>> 0, 0);
	return Buffer.concat([
		Buffer.from(solverBytes32.slice(2), "hex"),
		Buffer.from(orderId.slice(2), "hex"),
		ts,
		commonPayload
	]);
}

function findProveLogIndex(logMessages: string[]): number {
	return logMessages.findIndex((entry) => entry.includes("Program log: Prove: program:"));
}

async function computeGlobalLogIndex(
	connection: Connection,
	slot: number,
	signature: string,
	transactionLogIndex: number
): Promise<number> {
	const block = await connection.getBlock(slot, {
		commitment: "confirmed",
		maxSupportedTransactionVersion: 0,
		transactionDetails: "full",
		rewards: false
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

/**
 * Fill a single Solana output (output_settler_simple.fill or nativeFill),
 * read the local attestation timestamp, then call oracle_polymer.submit.
 * Returns a SolanaSubmittedFillRecord with all metadata needed for downstream proof + finalize.
 */
export async function fillAndSubmitSolanaOutput(params: {
	orderId: `0x${string}`;
	output: MandateOutput;
	fillDeadline: number;
	solverBytes32: `0x${string}`;
	solanaPublicKey: string;
	walletAdapter: SignerWalletAdapter;
	connection: Connection;
}): Promise<SolanaSubmittedFillRecord> {
	const { BN, AnchorProvider, Program } = await import("@coral-xyz/anchor");
	const { PublicKey, SystemProgram, ComputeBudgetProgram } = await import("@solana/web3.js");
	const { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } =
		await import("@solana/spl-token");

	const {
		orderId,
		output,
		fillDeadline,
		solverBytes32,
		solanaPublicKey,
		walletAdapter,
		connection
	} = params;
	const filler = new PublicKey(solanaPublicKey);
	const outputSettlerProgramId = new PublicKey(SOLANA_OUTPUT_SETTLER_SIMPLE);
	const intentsProtocolProgramId = new PublicKey(SOLANA_INTENTS_PROTOCOL);
	const polymerProgramId = new PublicKey(SOLANA_POLYMER_ORACLE);

	const anchorWallet = {
		publicKey: filler,
		signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) =>
			walletAdapter.signTransaction(tx),
		signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) =>
			walletAdapter.signAllTransactions(txs)
	};
	/* eslint-disable @typescript-eslint/no-explicit-any */
	const provider = new AnchorProvider(connection, anchorWallet as any, { commitment: "confirmed" });
	const outputSettlerProgram = new Program(outputSettlerIdl as any, provider);
	const polymerProgram = new Program(polymerIdl as any, provider);
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const [outputSettlerPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("output_settler_simple")],
		outputSettlerProgramId
	);
	const [polymerOraclePda] = PublicKey.findProgramAddressSync(
		[Buffer.from("polymer")],
		polymerProgramId
	);

	const outputHash = Buffer.from(getOutputHash(output).slice(2), "hex");
	const [fillId] = PublicKey.findProgramAddressSync(
		[Buffer.from(orderId.slice(2), "hex"), outputHash],
		outputSettlerProgramId
	);

	const commonPayload = encodeCommonPayload(output);
	const dataHash = Buffer.from(
		keccak256(encodeFillDescriptionWithoutTimestamp(solverBytes32, orderId, commonPayload)).slice(
			2
		),
		"hex"
	);
	const [localAttestation] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("local_attestation"),
			outputSettlerPda.toBuffer(),
			Buffer.from(output.oracle.slice(2), "hex"),
			dataHash
		],
		intentsProtocolProgramId
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
		context: output.context === "0x" ? Buffer.alloc(0) : Buffer.from(output.context.slice(2), "hex")
	};

	const recipient = new PublicKey(Buffer.from(output.recipient.slice(2), "hex"));
	const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

	/* eslint-disable @typescript-eslint/no-explicit-any */
	let fillMethodBuilder: any;
	if (output.token === BYTES32_ZERO) {
		fillMethodBuilder = outputSettlerProgram.methods
			.nativeFill(
				Array.from(Buffer.from(orderId.slice(2), "hex")),
				outputArg as any,
				new BN(fillDeadline),
				Buffer.from(solverBytes32.slice(2), "hex")
			)
			.accounts({
				filler,
				recipient,
				outputSettlerSimple: outputSettlerPda,
				fillId,
				localAttestation,
				intentsProtocolProgram: intentsProtocolProgramId,
				systemProgram: SystemProgram.programId
			} as any)
			.preInstructions([computeIx]);
	} else {
		const mint = new PublicKey(Buffer.from(output.token.slice(2), "hex"));
		const fillerTokenAccount = getAssociatedTokenAddressSync(mint, filler, false);
		const recipientTokenAccount = getAssociatedTokenAddressSync(mint, recipient, false);

		fillMethodBuilder = outputSettlerProgram.methods
			.fill(
				Array.from(Buffer.from(orderId.slice(2), "hex")),
				outputArg as any,
				new BN(fillDeadline),
				Buffer.from(solverBytes32.slice(2), "hex")
			)
			.accounts({
				filler,
				recipient,
				outputSettlerSimple: outputSettlerPda,
				fillerTokenAccount,
				recipientTokenAccount,
				mint,
				fillId,
				localAttestation,
				intentsProtocolProgram: intentsProtocolProgramId,
				tokenProgram: TOKEN_PROGRAM_ID,
				associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
				systemProgram: SystemProgram.programId
			} as any)
			.preInstructions([computeIx]);
	}

	// Build tx, sign with Phantom (shows balance changes), send manually
	const fillTx = await fillMethodBuilder.transaction();
	const { blockhash } = await connection.getLatestBlockhash("confirmed");
	fillTx.feePayer = filler;
	fillTx.recentBlockhash = blockhash;
	const signedFillTx = await walletAdapter.signTransaction(fillTx);
	const fillSignature = await sendAndConfirmSolanaTx(connection, signedFillTx.serialize());
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const localAttestationInfo = await connection.getAccountInfo(localAttestation, "confirmed");
	if (!localAttestationInfo || localAttestationInfo.data.length < 13) {
		throw new Error("Could not read Solana local attestation after fill");
	}
	const fillTimestamp = localAttestationInfo.data.readUInt32LE(8);
	const fillDescription = encodeFillDescriptionWithTimestamp(
		solverBytes32,
		orderId,
		fillTimestamp,
		commonPayload
	);
	// Submit the fill description to the Polymer oracle
	const submitComputeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
	/* eslint-disable @typescript-eslint/no-explicit-any */
	const submitTxObj = await polymerProgram.methods
		.submit(outputSettlerPda, [fillDescription] as any)
		.accounts({
			submitter: filler,
			oraclePolymer: polymerOraclePda,
			intentsProtocolProgram: intentsProtocolProgramId
		} as any)
		.remainingAccounts([{ pubkey: localAttestation, isWritable: false, isSigner: false }])
		.preInstructions([submitComputeIx])
		.transaction();
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const { blockhash: submitBlockhash } = await connection.getLatestBlockhash("confirmed");
	submitTxObj.feePayer = filler;
	submitTxObj.recentBlockhash = submitBlockhash;
	const signedSubmitTx = await walletAdapter.signTransaction(submitTxObj);
	const submitSignature = await sendAndConfirmSolanaTx(connection, signedSubmitTx.serialize());

	const submitTx = await connection.getTransaction(submitSignature, {
		commitment: "confirmed",
		maxSupportedTransactionVersion: 0
	});
	if (!submitTx?.meta?.logMessages || submitTx.slot === undefined) {
		throw new Error("Could not load Solana polymer submit transaction logs");
	}
	const submitLogIndex = findProveLogIndex(submitTx.meta.logMessages);
	if (submitLogIndex === -1) {
		throw new Error("Could not find Polymer prove log in Solana submit transaction");
	}
	const submitGlobalLogIndex = await computeGlobalLogIndex(
		connection,
		submitTx.slot,
		submitSignature,
		submitLogIndex
	);

	const record: SolanaSubmittedFillRecord = {
		kind: "solanaOutputSubmittedFill",
		fillSignature,
		submitSignature,
		fillTimestamp,
		solverBytes32,
		localAttestation: localAttestation.toBase58(),
		submitSlot: submitTx.slot,
		submitLogIndex: submitGlobalLogIndex,
		orderId
	};
	return record;
}

/**
 * Fill all Solana outputs for an EVM→Solana intent.
 * Returns one SolanaSubmittedFillRecord per output.
 */
export async function fillAndSubmitSolanaOutputs(params: {
	orderId: `0x${string}`;
	outputs: MandateOutput[];
	fillDeadline: number;
	solverBytes32: `0x${string}`;
	solanaPublicKey: string;
	walletAdapter: SignerWalletAdapter;
	connection: Connection;
}): Promise<SolanaSubmittedFillRecord[]> {
	const {
		orderId,
		outputs,
		fillDeadline,
		solverBytes32,
		solanaPublicKey,
		walletAdapter,
		connection
	} = params;
	const records: SolanaSubmittedFillRecord[] = [];
	for (const output of outputs) {
		const record = await fillAndSubmitSolanaOutput({
			orderId,
			output,
			fillDeadline,
			solverBytes32,
			solanaPublicKey,
			walletAdapter,
			connection
		});
		records.push(record);
	}
	return records;
}
