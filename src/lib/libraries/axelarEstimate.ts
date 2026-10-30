import { Operation, nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import { addressToBytes32, bytes32ToStellarContract } from "@lifi/intent";
import { bytesToHex, concatHex, encodeFunctionData, hexToBytes, parseAbi, toHex } from "viem";
import {
  AXELAR_ORACLE,
  AXELAR_CHAIN_NAMES,
  ADDRESS_ZERO,
  stellarDeployment,
  requireAlignedAxelar,
  isStellarChain
} from "$lib/config";
import { BASE_OUTPUT_SETTLER } from "./apiQuote";

export type AxelarGasRequest = {
  sourceChain: string;
  destinationChain: string;
  gasLimit: string;
  gasMultiplier: string;
  sourceTokenAddress: string;
  sourceContractAddress: string;
  destinationContractAddress: string;
  executeData: string;
};
/** Estimate-only IDs; these bytes never enter submit/approval/authentication. */
export function buildTestnetGasRequest(
  source: number,
  destination: number,
  payloads: `0x${string}`[],
  stellarExecutor?: string
): AxelarGasRequest {
  requireAlignedAxelar(source, destination);
  if (
    !Array.isArray(payloads) ||
    payloads.length < 1 ||
    payloads.length > 4 ||
    payloads.some(
      (p) => typeof p !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(p) || (p.length - 2) / 2 > 684
    )
  )
    throw new Error("Axelar Stellar message exceeds 1–4 × 684-byte payload bounds");
  const application = isStellarChain(source)
    ? stellarDeployment(BigInt(source))!.outputSettler
    : addressToBytes32(BASE_OUTPUT_SETTLER);
  const message = concatHex([
    application,
    toHex(payloads.length, { size: 2 }),
    ...payloads.flatMap((p) => [toHex((p.length - 2) / 2, { size: 2 }), p])
  ]);
  if ((message.length - 2) / 2 > 2778) throw new Error("Axelar message exceeds Stellar bound");
  const sender = isStellarChain(source)
    ? bytes32ToStellarContract(AXELAR_ORACLE[source]!)
    : AXELAR_ORACLE[source]!.toLowerCase();
  const receiver = isStellarChain(destination)
    ? bytes32ToStellarContract(AXELAR_ORACLE[destination]!)
    : AXELAR_ORACLE[destination]!.toLowerCase();
  const sourceName = AXELAR_CHAIN_NAMES[source]!;
  let executeData: string;
  if (isStellarChain(destination)) {
    if (!stellarExecutor || !StrKey.isValidEd25519PublicKey(stellarExecutor))
      throw new Error("Choose a Stellar Testnet relayer account to estimate receiving execution");
    const op = Operation.invokeContractFunction({
      source: stellarExecutor,
      contract: receiver,
      function: "execute",
      args: [
        nativeToScVal(sourceName, { type: "string" }),
        nativeToScVal("f".repeat(64), { type: "string" }),
        nativeToScVal(sender, { type: "string" }),
        nativeToScVal(hexToBytes(message))
      ]
    });
    executeData = bytesToHex(op.toXDR());
  } else {
    executeData = encodeFunctionData({
      abi: parseAbi([
        "function execute(bytes32 commandId,string sourceChain,string sourceAddress,bytes payload)"
      ]),
      functionName: "execute",
      args: [`0x${"ff".repeat(32)}`, sourceName, sender, message]
    });
  }
  return {
    sourceChain: sourceName,
    destinationChain: AXELAR_CHAIN_NAMES[destination]!,
    gasLimit: "500000",
    gasMultiplier: "auto",
    sourceTokenAddress: ADDRESS_ZERO,
    sourceContractAddress: sender,
    destinationContractAddress: receiver,
    executeData
  };
}
function integer(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value) || BigInt(value) >= 2n ** 256n)
    throw new Error("Invalid decimal-string gas amount");
  return BigInt(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Axelar response object");
  return value as Record<string, unknown>;
}
export function parseTestnetGasResponse(raw: unknown, request: AxelarGasRequest, decimals: 7 | 18) {
  const value = record(raw);
  if (!Array.isArray(value.details) || value.details.length !== 1)
    throw new Error("Invalid Axelar estimate hop count");
  const detail = record(value.details[0]);
  const echo = record(detail.apiResponse);
  const params = record(echo.params);
  const token = record(record(echo.result).source_token);
  if (
    echo.method !== "getFees" ||
    Object.keys(params).length !== Object.keys(request).length ||
    Object.entries(request).some(([key, expected]) => params[key] !== expected) ||
    detail.gasLimit !== request.gasLimit ||
    detail.executeData !== request.executeData ||
    typeof token.contract_address !== "string" ||
    token.contract_address.toLowerCase() !== ADDRESS_ZERO ||
    token.decimals !== decimals ||
    detail.totalFee !== value.totalFee
  )
    throw new Error("Axelar estimate request/native asset differs");
  const total = integer(value.totalFee);
  if (total <= 0n || integer(value.baseFee) + integer(value.executionFeeWithMultiplier) !== total)
    throw new Error("Invalid Axelar estimate total");
  return total;
}
export async function estimateTestnetGas(
  request: AxelarGasRequest,
  decimals: 7 | 18,
  fetcher: typeof fetch = fetch
) {
  const response = await fetcher("https://testnet.api.axelarscan.io/gmp/estimateGasFeeForNHops", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params: [request], showDetailedFees: true })
  });
  if (!response.ok) throw new Error(`Axelar estimator HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 262144) throw new Error("Axelar gas response too large");
  return parseTestnetGasResponse(JSON.parse(text), request, decimals);
}
