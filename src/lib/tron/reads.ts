import { decodeEventLog, hashStruct, toEventSelector } from "viem";
import { compactTypes } from "@lifi/intent";
import type { MandateOutput } from "@lifi/intent";
import { bytes32ToAddress } from "@lifi/intent";
import {
  TRON_INPUT_SETTLER_ABI,
  TRON_OUTPUT_SETTLER_ABI,
  TRON_POLYMER_ORACLE_ABI
} from "$lib/abi/tron";
import { ERC20_ABI } from "$lib/abi/erc20";
import type { TronTxInfo, TronWebLike } from "./types";

export function toTronAddress(tw: TronWebLike, hex: string): string {
  return tw.address.fromHex("41" + hex.replace(/^0x/, ""));
}

async function contractAt(reads: TronWebLike, abi: readonly unknown[], addressHex: string) {
  return reads.contract([...abi] as unknown[], toTronAddress(reads, addressHex));
}

/** Order status on a specific input settler — the settler MUST come from the
 * order container, never from global constants, so pre-rotation (legacy)
 * orders stay readable. */
export async function readOrderStatus(
  reads: TronWebLike,
  inputSettler: `0x${string}`,
  orderId: `0x${string}`
): Promise<number> {
  const contract = await contractAt(reads, TRON_INPUT_SETTLER_ABI, inputSettler);
  const status = await contract.orderStatus!(orderId).call();
  return Number(status);
}

export async function readIsOutputFilled(
  reads: TronWebLike,
  outputSettlerBytes32: `0x${string}`,
  orderId: `0x${string}`,
  outputHash: `0x${string}`
): Promise<boolean> {
  const contract = await contractAt(
    reads,
    TRON_OUTPUT_SETTLER_ABI,
    bytes32ToAddress(outputSettlerBytes32)
  );
  const record = (await contract.getFillRecord!(orderId, outputHash).call()) as string;
  return BigInt(record ?? 0) !== 0n;
}

export async function readIsProven(
  reads: TronWebLike,
  oracleHex: `0x${string}`,
  remoteChainId: bigint,
  remoteOracle: `0x${string}`,
  application: `0x${string}`,
  dataHash: `0x${string}`
): Promise<boolean> {
  const contract = await contractAt(reads, TRON_POLYMER_ORACLE_ABI, oracleHex);
  const result = await contract.isProven!(
    remoteChainId.toString(),
    remoteOracle,
    application,
    dataHash
  ).call();
  return Boolean(result);
}

export async function getTronTransactionInfo(
  reads: TronWebLike,
  txId: string
): Promise<TronTxInfo> {
  return reads.trx.getTransactionInfo(txId.replace(/^0x/, ""));
}

export async function getTrxBalance(
  reads: TronWebLike,
  accountHex: `0x${string}`
): Promise<bigint> {
  const balance = await reads.trx.getBalance(toTronAddress(reads, accountHex));
  return BigInt(balance);
}

export async function getTrc20Balance(
  reads: TronWebLike,
  tokenHex: `0x${string}`,
  accountHex: `0x${string}`
): Promise<bigint> {
  const contract = await contractAt(reads, ERC20_ABI, tokenHex);
  const balance = await contract.balanceOf!(toTronAddress(reads, accountHex)).call();
  return BigInt((balance as bigint | string | number).toString());
}

export async function getTrc20Allowance(
  reads: TronWebLike,
  tokenHex: `0x${string}`,
  ownerHex: `0x${string}`,
  spenderHex: `0x${string}`
): Promise<bigint> {
  const contract = await contractAt(reads, ERC20_ABI, tokenHex);
  const allowance = await contract.allowance!(
    toTronAddress(reads, ownerHex),
    toTronAddress(reads, spenderHex)
  ).call();
  return BigInt((allowance as bigint | string | number).toString());
}

// --- OutputFilled decoding --- //

const OUTPUT_FILLED_EVENT = {
  type: "event",
  name: "OutputFilled",
  inputs: [
    { name: "orderId", type: "bytes32", indexed: true },
    { name: "solver", type: "bytes32", indexed: false },
    { name: "timestamp", type: "uint32", indexed: false },
    {
      name: "output",
      type: "tuple",
      indexed: false,
      components: [
        { name: "oracle", type: "bytes32" },
        { name: "settler", type: "bytes32" },
        { name: "chainId", type: "uint256" },
        { name: "token", type: "bytes32" },
        { name: "amount", type: "uint256" },
        { name: "recipient", type: "bytes32" },
        { name: "callbackData", type: "bytes" },
        { name: "context", type: "bytes" }
      ]
    },
    { name: "finalAmount", type: "uint256", indexed: false }
  ]
} as const;

export const OUTPUT_FILLED_TOPIC = toEventSelector(
  "OutputFilled(bytes32,bytes32,uint32,(bytes32,bytes32,uint256,bytes32,uint256,bytes32,bytes,bytes),uint256)"
);

export function outputStructHash(output: MandateOutput): `0x${string}` {
  return hashStruct({
    types: compactTypes,
    primaryType: "MandateOutput",
    data: output
  });
}

export type DecodedFill = {
  solver: `0x${string}`;
  timestamp: number;
  finalAmount: bigint;
};

/**
 * Finds and decodes THE OutputFilled event matching the expected order and
 * output in a Tron `getTransactionInfo` payload. Strict by design:
 * - the transaction must have executed successfully,
 * - only logs whose emitter is the expected settler and whose topic0 is the
 *   deployed OutputFilled signature are considered,
 * - the indexed orderId and the decoded output's struct hash must match,
 * - more than one matching log is an error (never silently pick the first).
 *
 * Tron log format (verified, see tests/fixtures/tron/PREFLIGHT.md): `address`
 * is 20-byte hex without 0x/41 prefix; topics and data are unprefixed hex.
 * Only address FIELDS get 41-normalization — topics/data are used as-is.
 */
export function decodeOutputFilledFromTronLogs(
  txInfo: TronTxInfo,
  expected: {
    emitterBytes32: `0x${string}`;
    orderId: `0x${string}`;
    output: MandateOutput;
  }
): DecodedFill {
  if (
    txInfo.result === "FAILED" ||
    (txInfo.receipt?.result && txInfo.receipt.result !== "SUCCESS")
  ) {
    throw new Error(
      `Tron transaction did not execute successfully (${txInfo.receipt?.result ?? txInfo.result})`
    );
  }
  const logs = txInfo.log ?? [];
  const expectedEmitter = bytes32ToAddress(expected.emitterBytes32).toLowerCase();
  const expectedOrderId = expected.orderId.toLowerCase();
  const expectedHash = outputStructHash(expected.output).toLowerCase();

  const matches: DecodedFill[] = [];
  for (const log of logs) {
    const emitter = `0x${log.address.replace(/^0x/, "")}`.toLowerCase();
    if (emitter !== expectedEmitter) continue;
    const topics = log.topics.map((t) => `0x${t.replace(/^0x/, "")}` as `0x${string}`);
    if (topics[0]?.toLowerCase() !== OUTPUT_FILLED_TOPIC.toLowerCase()) continue;
    if (topics[1]?.toLowerCase() !== expectedOrderId) continue;

    const decoded = decodeEventLog({
      abi: [OUTPUT_FILLED_EVENT],
      data: `0x${(log.data ?? "").replace(/^0x/, "")}` as `0x${string}`,
      topics: topics as [`0x${string}`, ...`0x${string}`[]]
    });
    const args = decoded.args as unknown as {
      solver: `0x${string}`;
      timestamp: number;
      output: MandateOutput;
      finalAmount: bigint;
    };
    if (outputStructHash(args.output).toLowerCase() !== expectedHash) continue;
    if (BigInt(args.solver) === 0n) {
      throw new Error("OutputFilled event has a zero solver");
    }
    const timestamp = Number(args.timestamp);
    if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
      throw new Error(`OutputFilled timestamp out of uint32 range: ${args.timestamp}`);
    }
    matches.push({
      solver: args.solver,
      timestamp,
      finalAmount: BigInt(args.finalAmount)
    });
  }

  if (matches.length === 0) {
    throw new Error("No matching OutputFilled event found in Tron transaction");
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous fill: ${matches.length} OutputFilled events match the same order and output`
    );
  }
  return matches[0];
}
