import { parseEventLogs } from "viem";
import type { Connection } from "@solana/web3.js";
import type { SigningWalletAdapter } from "./anchorTypes";
import type { MandateOutput } from "@lifi/intent";
import type {
  OrderContainer,
  SolanaFilledRecord,
  SolanaSubmittedFillRecord,
  SvmOrderData,
} from "../../types/shared";
import {
  fillAndSubmitSolanaOutput,
  fillSolanaOutput,
  submitFilledSolanaOutput,
} from "./solanaFill";
import { deriveAttestationPda, encodeCommonPayload, encodeFillDescription } from "./solanaValidate";
import { deriveOrderContextPda, finaliseSolanaEscrow } from "./solanaFinalize";
import { COIN_FILLER_ABI } from "../abi/outputSettler";
import { getEvmClient } from "../config/evm";
import { isSolanaViemChainId } from "../config/svm";

export type { SolanaSubmittedFillRecord };
export { fillSolanaOutput, submitFilledSolanaOutput };

export async function fillSolanaOutputs(params: {
  container: OrderContainer;
  solverBytes32: `0x${string}`;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<SolanaFilledRecord[]> {
  const {
    container,
    solverBytes32,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  } = params;
  const { order } = container;

  const records: SolanaFilledRecord[] = [];
  for (const output of order.outputs) {
    if (!isSolanaViemChainId(output.chainId)) continue;
    const record = await fillSolanaOutput({
      orderId: container.orderId as `0x${string}`,
      output,
      fillDeadline: order.fillDeadline,
      solverBytes32,
      solanaPublicKey,
      walletAdapter,
      connection,
      mainnet,
    });
    records.push(record);
  }
  return records;
}

export async function submitFilledSolanaOutputs(params: {
  container: OrderContainer;
  records: SolanaFilledRecord[];
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<SolanaSubmittedFillRecord[]> {
  const {
    container,
    records,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  } = params;
  const solanaOutputs = container.order.outputs.filter((output) =>
    isSolanaViemChainId(output.chainId),
  );
  if (solanaOutputs.length !== records.length) {
    throw new Error(
      `Solana fill record count (${records.length}) does not match Solana output count (${solanaOutputs.length}).`,
    );
  }

  const submittedRecords: SolanaSubmittedFillRecord[] = [];
  for (let i = 0; i < solanaOutputs.length; i++) {
    const output = solanaOutputs[i];
    const record = records[i];
    if (!output || !record) continue;
    submittedRecords.push(await submitFilledSolanaOutput({
      record,
      output,
      solanaPublicKey,
      walletAdapter,
      connection,
      mainnet,
    }));
  }
  return submittedRecords;
}

/**
 * Fill all Solana outputs for an EVM->Solana intent.
 * Returns one SolanaSubmittedFillRecord per Solana output (in the same order
 * as they appear in `order.outputs`). EVM outputs are skipped — they're
 * filled separately via `fillEvmOutputs`.
 */
export async function fillAndSubmitSolanaOutputs(params: {
  container: OrderContainer;
  solverBytes32: `0x${string}`;
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<SolanaSubmittedFillRecord[]> {
  const {
    container,
    solverBytes32,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  } = params;
  const { order } = container;

  const records: SolanaSubmittedFillRecord[] = [];
  for (const output of order.outputs) {
    if (!isSolanaViemChainId(output.chainId)) continue;
    const record = await fillAndSubmitSolanaOutput({
      orderId: container.orderId as `0x${string}`,
      output,
      fillDeadline: order.fillDeadline,
      solverBytes32,
      solanaPublicKey,
      walletAdapter,
      connection,
      mainnet,
    });
    records.push(record);
  }
  return records;
}

/**
 * For a Solana->EVM intent:
 * 1. Fetch EVM fill receipts, parse OutputFilled events
 * 2. Derive attestation PDAs
 * 3. Call finaliseSolanaEscrow
 */
export async function submitProofAndFinalizeSolanaEscrow(params: {
  container: OrderContainer;
  fillTransactionHashes: string[];
  solanaPublicKey: string;
  walletAdapter: SigningWalletAdapter;
  connection: Connection;
  mainnet: boolean;
}): Promise<string> {
  const {
    container,
    fillTransactionHashes,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  } = params;
  const { order } = container;

  if (order.kind !== "svm_standard") {
    throw new Error("submitProofAndFinalizeSolanaEscrow expects a svm_standard order");
  }
  const orderData = order as SvmOrderData;

  if (fillTransactionHashes.length !== order.outputs.length) {
    throw new Error(
      `Fill tx count (${fillTransactionHashes.length}) does not match output count (${order.outputs.length}).`,
    );
  }

  const solveParams: { solver: number[]; timestamp: number }[] = [];
  const attestationPdas: string[] = [];

  for (let i = 0; i < order.outputs.length; i++) {
    const output: MandateOutput = order.outputs[i];
    const txHash = fillTransactionHashes[i];

    if (!txHash.startsWith("0x") || txHash.length !== 66) {
      throw new Error(`Invalid fill tx hash at index ${i}: ${txHash}`);
    }

    const receipt = await getEvmClient(Number(output.chainId)).getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    const logs = parseEventLogs({
      abi: COIN_FILLER_ABI,
      eventName: "OutputFilled",
      logs: receipt.logs,
    });

    if (logs.length === 0) {
      throw new Error(`No OutputFilled log found in tx ${txHash}`);
    }

    const log = logs[0];
    const fillTimestamp = Number(log.args.timestamp);
    const solverBytes32 = log.args.solver as `0x${string}`;

    solveParams.push({
      solver: Array.from(Buffer.from(solverBytes32.slice(2), "hex")),
      timestamp: fillTimestamp,
    });

    const attestationPda = await deriveAttestationPda({
      evmChainId: output.chainId,
      output,
      orderId: container.orderId as `0x${string}`,
      fillTimestamp,
      solverBytes32,
      mainnet,
    });
    attestationPdas.push(attestationPda);
  }

  return finaliseSolanaEscrow({
    orderData,
    orderId: container.orderId,
    solveParams,
    attestationPdas,
    solanaPublicKey,
    walletAdapter,
    connection,
    mainnet,
  });
}

/**
 * Check if a Solana escrow has been finalized (order_context PDA closed).
 */
export async function checkSolanaEscrowClaimed(
  orderId: string,
  connection: Connection,
  mainnet: boolean,
): Promise<boolean> {
  const { PublicKey } = await import("@solana/web3.js");
  const pdaAddress = await deriveOrderContextPda(orderId, mainnet);
  const accountInfo = await connection.getAccountInfo(new PublicKey(pdaAddress), "confirmed");
  return accountInfo === null;
}
