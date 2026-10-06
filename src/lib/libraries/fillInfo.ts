import { getClient, isStellarChain } from "$lib/config";
import { encodePacked, hashStruct, keccak256, parseEventLogs } from "viem";
import {
  addressToBytes32,
  compactTypes,
  encodeFillDescription,
  getOutputHash,
  stellarAddressCommitment,
  type MandateOutput,
  type MultichainOrder,
  type StandardOrder
} from "@lifi/intent";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import store from "$lib/state.svelte";
import { getStellarTransaction, stellarFillRecord } from "./stellar";

export async function persistReceipt(
  chainId: number | bigint,
  txHash: `0x${string}`,
  receipt: unknown
) {
  try {
    await store.saveTransactionReceipt(chainId, txHash, receipt);
  } catch (error) {
    console.warn("saveTransactionReceipt error", { chainId: Number(chainId), txHash, error });
  }
}

export async function getReceiptCachedOrRpc(chainId: number | bigint, txHash: `0x${string}`) {
  const cached = store.getTransactionReceipt(chainId, txHash);
  if (cached && Array.isArray(cached.logs) && cached.logs.length > 0) return cached;
  const receipt = await getClient(chainId).getTransactionReceipt({ hash: txHash });
  await persistReceipt(chainId, txHash, receipt);
  return receipt;
}

/** Ledger close time of a Stellar transaction: local cache first, then RPC (~7 day retention). */
export async function fetchStellarTransaction(hash: `0x${string}`) {
  const cached = store.getStellarTransaction(hash);
  if (cached) return cached;
  const tx = await getStellarTransaction(hash);
  if (!tx) throw new Error(`Stellar transaction ${hash} not found (RPC keeps ~7 days)`);
  await store.saveStellarTransaction(hash, tx);
  return tx;
}

/**
 * 32-byte identity the connected solver fills and finalises as. A Stellar
 * escrow pays the claimant whose address commitment matches the fill; EVM
 * escrows pay the low 20 bytes.
 */
export function solverIdentityFor(order: StandardOrder | MultichainOrder): `0x${string}` {
  if ("originChainId" in order && isStellarChain(order.originChainId)) {
    if (!store.stellarAccount) throw new Error("Connect a Stellar wallet first");
    return stellarAddressCommitment(store.stellarAccount);
  }
  if (!store.connectedAccount) throw new Error("Connect an EVM wallet first");
  return addressToBytes32(store.connectedAccount.address);
}

/** The `OutputFilled` log for `output` in an EVM fill transaction. */
export async function findOutputFilledLog(
  output: MandateOutput,
  fillTransactionHash: `0x${string}`
) {
  const receipt = await getReceiptCachedOrRpc(output.chainId, fillTransactionHash);
  const expectedOutputHash = hashStruct({
    types: compactTypes,
    primaryType: "MandateOutput",
    data: output
  });
  const log = parseEventLogs({
    abi: COIN_FILLER_ABI,
    eventName: "OutputFilled",
    logs: receipt.logs
  }).find(
    (log) =>
      hashStruct({ types: compactTypes, primaryType: "MandateOutput", data: log.args.output }) ===
      expectedOutputHash
  );
  if (!log) throw new Error("Could not find matching log");
  return { receipt, log };
}

/**
 * Solver, fill timestamp and FillDescription payload of a filled output — the
 * values oracles prove and escrows check on finalise.
 */
export async function getFillInfo(args: {
  orderId: `0x${string}`;
  output: MandateOutput;
  fillTransactionHash: `0x${string}`;
}): Promise<{ solver: `0x${string}`; timestamp: number; payload: `0x${string}` }> {
  const { orderId, output, fillTransactionHash } = args;
  let solver: `0x${string}`;
  let timestamp: number;
  if (isStellarChain(output.chainId)) {
    // Stellar outputs only exist on EVM-origin orders, filled by the EVM account.
    ({ createdAt: timestamp } = await fetchStellarTransaction(fillTransactionHash));
    if (!store.connectedAccount) throw new Error("Connect an EVM wallet first");
    solver = addressToBytes32(store.connectedAccount.address);
    const record = await stellarFillRecord(orderId, getOutputHash(output));
    const expected = keccak256(encodePacked(["bytes32", "uint32"], [solver, timestamp]));
    if (record !== expected)
      throw new Error("Stellar fill was not made by the connected EVM account");
  } else {
    const { log } = await findOutputFilledLog(output, fillTransactionHash);
    solver = log.args.solver;
    timestamp = Number(log.args.timestamp);
  }
  return {
    solver,
    timestamp,
    payload: encodeFillDescription({ solver, orderId, timestamp, output })
  };
}
