import axios from "axios";
import { keccak256 } from "viem";
import idl from "../abi/polymer_oracle.json";
import { SOLANA_INTENTS_PROTOCOL, SOLANA_POLYMER_ORACLE } from "../config";
import type { MandateOutput } from "@lifi/intent";

const POLYMER_PROVER_PROGRAM = "CdvSq48QUukYuMczgZAVNZrwcHNshBdtqrjW26sQiGPs";

/** Convert a bigint to a 16-byte little-endian Buffer (u128 LE) */
function u128ToLeBytes(n: bigint): Buffer {
	const buf = Buffer.alloc(16);
	const bn = BigInt(n);
	buf.writeBigUInt64LE(bn & 0xffffffffffffffffn, 0);
	buf.writeBigUInt64LE(bn >> 64n, 8);
	return buf;
}

function normalizeBytes32Hex(value: `0x${string}`): Buffer {
	return Buffer.from(value.slice(2), "hex");
}

function normalizeEvmIdentifier(
	value: `0x${string}` | undefined,
	fallbackBytes32: `0x${string}`
): Buffer {
	if (!value) return normalizeBytes32Hex(fallbackBytes32);
	const hex = value.slice(2);
	if (hex.length === 40) return Buffer.from(hex.padStart(64, "0"), "hex");
	if (hex.length === 64) return Buffer.from(hex, "hex");
	throw new Error(`Invalid EVM identifier length: ${value.length}`);
}

/** Encode the common payload for a MandateOutput */
export function encodeCommonPayload(output: MandateOutput): Buffer {
	const token = Buffer.from(output.token.slice(2), "hex");
	const amountHex = BigInt(output.amount).toString(16).padStart(64, "0");
	const amount = Buffer.from(amountHex, "hex");
	const recipient = Buffer.from(output.recipient.slice(2), "hex");
	const callbackData =
		output.callbackData === "0x"
			? Buffer.alloc(0)
			: Buffer.from(output.callbackData.slice(2), "hex");
	const context =
		output.context === "0x" ? Buffer.alloc(0) : Buffer.from(output.context.slice(2), "hex");
	const callLen = Buffer.alloc(2);
	callLen.writeUInt16BE(callbackData.length, 0);
	const ctxLen = Buffer.alloc(2);
	ctxLen.writeUInt16BE(context.length, 0);
	return Buffer.concat([token, amount, recipient, callLen, callbackData, ctxLen, context]);
}

/** Encode fill description: solver(32) || orderId(32) || timestamp(4,BE) || commonPayload */
export function encodeFillDescription(
	solverBytes32: `0x${string}`,
	orderId: `0x${string}`,
	timestamp: number,
	commonPayload: Buffer
): Buffer {
	const solver = Buffer.from(solverBytes32.slice(2), "hex");
	const orderIdBytes = Buffer.from(orderId.slice(2), "hex");
	const ts = Buffer.alloc(4);
	ts.writeUInt32BE(timestamp >>> 0, 0);
	return Buffer.concat([solver, orderIdBytes, ts, commonPayload]);
}

/**
 * Derive the attestation PDA for a given fill.
 * Seeds: [b"attestation", oracle_polymer_pda, evmChainId_le16, output.oracle, output.settler, payloadHash]
 * Program: SOLANA_INTENTS_PROTOCOL
 */
export async function deriveAttestationPda(params: {
	evmChainId: bigint;
	output: MandateOutput;
	proofOutput?: MandateOutput;
	orderId: `0x${string}`;
	fillTimestamp: number;
	solverBytes32: `0x${string}`;
	emittingContract?: `0x${string}`;
}): Promise<string> {
	const { PublicKey } = await import("@solana/web3.js");
	const polymerOracleProgram = new PublicKey(SOLANA_POLYMER_ORACLE);
	const intentsProtocol = new PublicKey(SOLANA_INTENTS_PROTOCOL);

	const [oraclePolymerPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("polymer")],
		polymerOracleProgram
	);

	const payloadOutput = params.proofOutput ?? params.output;
	const chainIdSeed = u128ToLeBytes(params.evmChainId);
	const commonPayload = encodeCommonPayload(payloadOutput);
	const fillDesc = encodeFillDescription(
		params.solverBytes32,
		params.orderId,
		params.fillTimestamp,
		commonPayload
	);
	const payloadHash = Buffer.from(keccak256(fillDesc).slice(2), "hex");
	const source = normalizeBytes32Hex(payloadOutput.oracle);
	const application = normalizeEvmIdentifier(params.emittingContract, payloadOutput.settler);

	const [attestationPda] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("attestation"),
			oraclePolymerPda.toBuffer(),
			chainIdSeed,
			source,
			application,
			payloadHash
		],
		intentsProtocol
	);

	return attestationPda.toBase58();
}

/**
 * Submit a Polymer proof to the Solana oracle_polymer.receive() instruction.
 * Fetches the proof from the /polymer API (hex-encoded) then calls oracle_polymer.receive().
 */
export async function submitProofToSolanaOracle(params: {
	evmChainId: bigint;
	output: MandateOutput;
	proofOutput?: MandateOutput;
	orderId: `0x${string}`;
	fillTimestamp: number;
	solverBytes32: `0x${string}`;
	emittingContract?: `0x${string}`;
	fillBlockNumber: number;
	globalLogIndex: number;
	mainnet: boolean;
	solanaPublicKey: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	walletAdapter: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	connection: any;
}): Promise<string> {
	const { AnchorProvider, Program } = await import("@coral-xyz/anchor");
	const { PublicKey, SystemProgram, ComputeBudgetProgram } = await import("@solana/web3.js");

	const signerPubkey = new PublicKey(params.solanaPublicKey);
	const polymerOracleProgram = new PublicKey(SOLANA_POLYMER_ORACLE);
	const polymerProverProgramId = new PublicKey(POLYMER_PROVER_PROGRAM);
	const intentsProtocolId = new PublicKey(SOLANA_INTENTS_PROTOCOL);

	// Fetch Polymer proof via /polymer route (returns hex-encoded bytes)
	let proof: string | undefined;
	let polymerIndex: number | undefined;
	for (const waitMs of [0, 2000, 4000, 8000, 16000]) {
		if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
		const response = await axios.post(
			"/polymer",
			{
				srcChainId: Number(params.evmChainId),
				srcBlockNumber: params.fillBlockNumber,
				globalLogIndex: params.globalLogIndex,
				polymerIndex,
				mainnet: params.mainnet
			},
			{ timeout: 15_000 }
		);
		const dat = response.data as { proof: string | undefined; polymerIndex: number };
		polymerIndex = dat.polymerIndex;
		if (dat.proof) {
			proof = dat.proof;
			break;
		}
	}
	if (!proof) {
		throw new Error("Polymer proof unavailable. Try again after the fill attestation is indexed.");
	}

	// Derive PDAs
	const [oraclePolymerPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("polymer")],
		polymerOracleProgram
	);
	const chainIdSeed = u128ToLeBytes(params.evmChainId);

	const [chainMapping] = PublicKey.findProgramAddressSync(
		[Buffer.from("chain_mapping"), oraclePolymerPda.toBuffer(), chainIdSeed],
		intentsProtocolId
	);
	const [cacheAccount] = PublicKey.findProgramAddressSync(
		[Buffer.from("cache"), signerPubkey.toBuffer()],
		polymerProverProgramId
	);
	const [internalAccount] = PublicKey.findProgramAddressSync(
		[Buffer.from("internal")],
		polymerProverProgramId
	);
	const [resultAccount] = PublicKey.findProgramAddressSync(
		[Buffer.from("result"), signerPubkey.toBuffer()],
		polymerProverProgramId
	);

	// Attestation PDA (goes into remaining_accounts as writable)
	const payloadOutput = params.proofOutput ?? params.output;
	const commonPayload = encodeCommonPayload(payloadOutput);
	const fillDesc = encodeFillDescription(
		params.solverBytes32,
		params.orderId,
		params.fillTimestamp,
		commonPayload
	);
	const payloadHash = Buffer.from(keccak256(fillDesc).slice(2), "hex");
	const source = normalizeBytes32Hex(payloadOutput.oracle);
	const emittingContractApplication = normalizeEvmIdentifier(
		params.emittingContract,
		payloadOutput.settler
	);

	const [attestationPda] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("attestation"),
			oraclePolymerPda.toBuffer(),
			chainIdSeed,
			source,
			emittingContractApplication,
			payloadHash
		],
		intentsProtocolId
	);

	// Build Anchor program
	const anchorWallet = {
		publicKey: signerPubkey,
		signTransaction: (tx: unknown) => params.walletAdapter.signTransaction(tx),
		signAllTransactions: (txs: unknown[]) => params.walletAdapter.signAllTransactions(txs)
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const typedIdl = idl as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const provider = new AnchorProvider(params.connection, anchorWallet as any, {
		commitment: "confirmed"
	});
	const program = new Program(typedIdl, provider);

	const proofBytes = Buffer.from(proof, "hex");
	// Increase compute budget for chained CPI into IntentsProtocol
	const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

	return await program.methods
		.receive([proofBytes] as any)
		.accounts({
			signer: signerPubkey,
			oraclePolymer: oraclePolymerPda,
			polymerProverProgram: polymerProverProgramId,
			chainMapping,
			cacheAccount,
			internal: internalAccount,
			resultAccount,
			intentsProtocolProgram: intentsProtocolId,
			systemProgram: SystemProgram.programId
		} as any)
		.remainingAccounts([{ pubkey: attestationPda, isWritable: true, isSigner: false }])
		.preInstructions([computeIx])
		.rpc({ commitment: "confirmed" });
}
