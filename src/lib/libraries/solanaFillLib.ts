import { keccak256 } from "viem";
import polymerIdl from "../abi/polymer_oracle.json";
import {
	BYTES32_ZERO,
	SOLANA_INTENTS_PROTOCOL,
	SOLANA_OUTPUT_SETTLER_SIMPLE,
	SOLANA_POLYMER_ORACLE
} from "../config";
import { getOutputHash } from "@lifi/intent";
import { encodeCommonPayload } from "./solanaValidateLib";
import type { MandateOutput } from "@lifi/intent";

const OUTPUT_SETTLER_SIMPLE_IDL = {
	address: SOLANA_OUTPUT_SETTLER_SIMPLE,
	metadata: {
		name: "outputSettlerSimple",
		version: "0.0.0",
		spec: "0.1.0"
	},
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
				{ name: "systemProgram" }
			],
			args: [
				{ name: "orderId", type: { array: ["u8", 32] } },
				{ name: "mandateOutput", type: { defined: { name: "mandateOutput" } } },
				{ name: "fillDeadline", type: "u64" },
				{ name: "fillerData", type: "bytes" }
			]
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
				{ name: "systemProgram" }
			],
			args: [
				{ name: "orderId", type: { array: ["u8", 32] } },
				{ name: "mandateOutput", type: { defined: { name: "mandateOutput" } } },
				{ name: "fillDeadline", type: "u64" },
				{ name: "fillerData", type: "bytes" }
			]
		}
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
					{ name: "context", type: "bytes" }
				]
			}
		}
	]
} as const;

export const SOLANA_POLYMER_SOURCE_CHAIN_ID = 2;

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

function encodeFillDescription(
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	connection: any,
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

export async function fillAndSubmitSolanaOutput(params: {
	orderId: `0x${string}`;
	output: MandateOutput;
	fillDeadline: number;
	solverBytes32: `0x${string}`;
	solanaPublicKey: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	walletAdapter: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	connection: any;
}): Promise<SolanaSubmittedFillRecord> {
	const { BN, AnchorProvider, Program } = await import("@coral-xyz/anchor");
	const { PublicKey, SystemProgram } = await import("@solana/web3.js");
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
		signTransaction: (tx: unknown) => walletAdapter.signTransaction(tx),
		signAllTransactions: (txs: unknown[]) => walletAdapter.signAllTransactions(txs)
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const provider = new AnchorProvider(connection, anchorWallet as any, { commitment: "confirmed" });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const outputSettlerProgram = new Program(OUTPUT_SETTLER_SIMPLE_IDL as any, provider);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const polymerProgram = new Program(polymerIdl as any, provider);

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

	let fillSignature: string;
	if (output.token === BYTES32_ZERO) {
		const recipient = new PublicKey(Buffer.from(output.recipient.slice(2), "hex"));
		fillSignature = await outputSettlerProgram.methods
			.nativeFill(
				Array.from(Buffer.from(orderId.slice(2), "hex")),
				outputArg as never,
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
			})
			.rpc({ commitment: "confirmed" });
	} else {
		const recipient = new PublicKey(Buffer.from(output.recipient.slice(2), "hex"));
		const mint = new PublicKey(Buffer.from(output.token.slice(2), "hex"));
		const fillerTokenAccount = getAssociatedTokenAddressSync(mint, filler, false);
		const recipientTokenAccount = getAssociatedTokenAddressSync(mint, recipient, false);
		fillSignature = await outputSettlerProgram.methods
			.fill(
				Array.from(Buffer.from(orderId.slice(2), "hex")),
				outputArg as never,
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
			})
			.rpc({ commitment: "confirmed" });
	}

	const localAttestationInfo = await connection.getAccountInfo(localAttestation, "confirmed");
	if (!localAttestationInfo || localAttestationInfo.data.length < 13) {
		throw new Error("Could not read Solana local attestation after fill");
	}
	const fillTimestamp = localAttestationInfo.data.readUInt32LE(8);
	const fillDescription = encodeFillDescription(
		solverBytes32,
		orderId,
		fillTimestamp,
		commonPayload
	);

	const submitSignature = await polymerProgram.methods
		.submit(outputSettlerPda, [fillDescription] as never)
		.accounts({
			submitter: filler,
			oraclePolymer: polymerOraclePda,
			intentsProtocolProgram: intentsProtocolProgramId
		})
		.remainingAccounts([{ pubkey: localAttestation, isWritable: false, isSigner: false }])
		.rpc({ commitment: "confirmed" });

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

	return {
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
}
