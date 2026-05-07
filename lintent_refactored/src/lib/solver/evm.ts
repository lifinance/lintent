import { hashStruct, maxUint256, parseEventLogs } from "viem";
import type { WalletClient } from "viem";
import type { MandateOutput } from "@lifi/intent";
import {
  addressToBytes32,
  bytes32ToAddress,
  compactTypes,
  BYTES32_ZERO,
  COIN_FILLER,
  INPUT_SETTLER_ESCROW_LIFI,
  INPUT_SETTLER_COMPACT_LIFI,
} from "@lifi/intent";
import { toEvmAddress } from "../config/shared";
import { COIN_FILLER_ABI } from "../abi/outputSettler";
import { ERC20_ABI } from "../abi/erc20";
import { POLYMER_ORACLE_ABI } from "../abi/polymerOracle";
import { SETTLER_ESCROW_ABI } from "../abi/escrow";
import { getEvmChain, getEvmClient, POLYMER_ORACLE } from "../config/evm";
import type {
  OrderContainer,
  SolanaFillRecord,
} from "../../types/shared";
import { isSolanaSubmittedFillRecord } from "../../types/shared";
import {
  isSolanaViemChainId,
  getSolanaPrograms,
  getSolanaNetwork,
} from "../config/svm";

export const SOLANA_POLYMER_SOURCE_CHAIN_ID = 2;

async function ensureWalletOnChain(
  walletClient: WalletClient,
  targetChainId: number,
): Promise<void> {
  if (walletClient.chain?.id === targetChainId) return;
  await walletClient.switchChain({ id: targetChainId });
}

export async function fillEvmOutputs(params: {
  walletClient: WalletClient;
  orderId: `0x${string}`;
  outputs: MandateOutput[];
  fillDeadline: number;
  solverBytes32?: `0x${string}`;
  account: `0x${string}`;
}): Promise<`0x${string}`> {
  const { walletClient, orderId, outputs, fillDeadline, account } = params;
  const solverBytes32 =
    params.solverBytes32 ?? addressToBytes32(toEvmAddress(account));

  const outputChainId = Number(outputs[0].chainId);
  const outputChain = getEvmChain(outputChainId);
  const publicClient = getEvmClient(outputChainId);

  await ensureWalletOnChain(walletClient, outputChainId);

  let value = 0n;
  for (const output of outputs) {
    if (output.token === BYTES32_ZERO) {
      value += output.amount;
      continue;
    }
    const assetAddress = bytes32ToAddress(output.token);
    const allowance = await publicClient.readContract({
      address: assetAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account, bytes32ToAddress(output.settler)],
    });
    if (BigInt(allowance) < output.amount) {
      const approveTx = await walletClient.writeContract({
        chain: outputChain,
        account,
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [bytes32ToAddress(output.settler), maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }
  }

  const txHash = await walletClient.writeContract({
    chain: outputChain,
    account,
    address: bytes32ToAddress(outputs[0].settler),
    value,
    abi: COIN_FILLER_ABI,
    functionName: "fillOrderOutputs",
    args: [orderId, outputs, fillDeadline, solverBytes32],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function validateEvmFill(params: {
  walletClient: WalletClient;
  output: MandateOutput;
  fillTransactionRef: string;
  fillRecordKey: string;
  inputOracle: `0x${string}`;
  sourceChainId: number;
  mainnet: boolean;
  account: `0x${string}`;
  getFillRecord: (key: string) => SolanaFillRecord | undefined;
}): Promise<`0x${string}`> {
  const {
    walletClient,
    output,
    fillTransactionRef,
    fillRecordKey,
    inputOracle,
    sourceChainId,
    mainnet,
    account,
    getFillRecord,
  } = params;

  const sourceChain = getEvmChain(sourceChainId);
  const sourceClient = getEvmClient(sourceChainId);

  await ensureWalletOnChain(walletClient, sourceChainId);

  // Solana output path: use SolanaSubmittedFillRecord
  if (isSolanaViemChainId(output.chainId)) {
    const record = getFillRecord(fillRecordKey);
    if (!record || !isSolanaSubmittedFillRecord(record)) {
      throw new Error(
        `Missing Solana fill metadata for ref ${fillTransactionRef}`,
      );
    }

    // Pick the polymer-oracle program ID matching the active network so the
    // Polymer indexer can locate the submit log on the correct cluster.
    const solanaPolymerProgram = getSolanaPrograms(getSolanaNetwork(mainnet))
      .POLYMER_ORACLE;
    let proof: string | undefined;
    let polymerIndex: number | undefined;
    for (const waitMs of [1000, 2000, 4000, 8000, 16000, 32000]) {
      await new Promise((r) => setTimeout(r, waitMs));
      const res = await fetch("/api/polymer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          srcChainId: SOLANA_POLYMER_SOURCE_CHAIN_ID,
          txSignature: record.submitSignature,
          programID: solanaPolymerProgram,
          polymerIndex,
          mainnet,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Polymer API error (${res.status}): ${text}`);
      }
      const dat = (await res.json()) as {
        proof: string | undefined;
        polymerIndex: number;
        error?: string;
      };
      if (dat.error) throw new Error(`Polymer: ${dat.error}`);
      polymerIndex = dat.polymerIndex;
      if (dat.proof) {
        proof = dat.proof;
        break;
      }
    }
    if (!proof) {
      throw new Error(
        `Polymer proof unavailable for Solana output. txSignature=${record.submitSignature}. Try again after the submit transaction is indexed.`,
      );
    }

    const txHash = await walletClient.writeContract({
      chain: sourceChain,
      account,
      address: inputOracle,
      abi: POLYMER_ORACLE_ABI,
      functionName: "receiveSolanaMessage",
      args: [`0x${proof.replace("0x", "")}`],
    });
    const receipt = await sourceClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });
    if (receipt.status !== "success") {
      throw new Error(
        `receiveSolanaMessage reverted on chain ${sourceChainId} (tx ${txHash}). ` +
          `The Polymer attestation was not stored — finalise will fail. ` +
          `Inspect the tx on the explorer for the revert reason.`,
      );
    }
    return txHash;
  }

  // EVM output path: parse OutputFilled event, get Polymer proof
  if (
    !fillTransactionRef.startsWith("0x") ||
    fillTransactionRef.length !== 66
  ) {
    throw new Error(`Invalid fill transaction hash: ${fillTransactionRef}`);
  }

  const receipt = await getEvmClient(
    Number(output.chainId),
  ).getTransactionReceipt({
    hash: fillTransactionRef as `0x${string}`,
  });

  const logs = parseEventLogs({
    abi: COIN_FILLER_ABI,
    eventName: "OutputFilled",
    logs: receipt.logs,
  });

  // Normalise hex fields to lowercase before hashing. viem's hashStruct hashes
  // bytes32 values via keccak256 on their normalised byte representation, but
  // EIP-55-checksummed addresses come back from event parsing mixed-case while
  // the order we built uses the `addressToBytes32` lowercase form. Canonicalise
  // both sides so the hash comparison is case-insensitive for hex fields.
  const normaliseOutput = (o: MandateOutput): MandateOutput => ({
    oracle: o.oracle.toLowerCase() as `0x${string}`,
    settler: o.settler.toLowerCase() as `0x${string}`,
    chainId: BigInt(o.chainId),
    token: o.token.toLowerCase() as `0x${string}`,
    amount: BigInt(o.amount),
    recipient: o.recipient.toLowerCase() as `0x${string}`,
    callbackData: (o.callbackData ?? "0x").toLowerCase() as `0x${string}`,
    context: (o.context ?? "0x").toLowerCase() as `0x${string}`,
  });

  const expectedOutputHash = hashStruct({
    types: compactTypes,
    primaryType: "MandateOutput",
    data: normaliseOutput(output),
  });

  let logIndex = -1;
  const seen: { idx: number; hash: string; output: MandateOutput }[] = [];
  for (const log of logs) {
    const normalisedLogOutput = normaliseOutput(log.args.output as MandateOutput);
    const logOutputHash = hashStruct({
      types: compactTypes,
      primaryType: "MandateOutput",
      data: normalisedLogOutput,
    });
    seen.push({ idx: log.logIndex, hash: logOutputHash, output: normalisedLogOutput });
    if (logOutputHash === expectedOutputHash) {
      logIndex = log.logIndex;
      break;
    }
  }
  if (logIndex === -1) {
    const expectedStr = JSON.stringify(normaliseOutput(output), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    const seenStr = JSON.stringify(
      seen.map((s) => ({ idx: s.idx, hash: s.hash, output: s.output })),
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    throw new Error(
      `Could not find matching OutputFilled log.\n` +
        `Expected hash: ${expectedOutputHash}\n` +
        `Expected output: ${expectedStr}\n` +
        `Seen ${seen.length} event(s): ${seenStr}`,
    );
  }

  const polymerOracleAddress = POLYMER_ORACLE[sourceChainId];
  if (inputOracle.toLowerCase() === polymerOracleAddress?.toLowerCase()) {
    let proof: string | undefined;
    let polymerIndex: number | undefined;
    for (const waitMs of [1000, 2000, 4000, 8000]) {
      await new Promise((r) => setTimeout(r, waitMs));
      const res = await fetch("/api/polymer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          srcChainId: Number(output.chainId),
          srcBlockNumber: Number(receipt.blockNumber),
          globalLogIndex: Number(logIndex),
          polymerIndex,
          mainnet,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Polymer API error (${res.status}): ${text}`);
      }
      const dat = (await res.json()) as {
        proof: string | undefined;
        polymerIndex: number;
        error?: string;
      };
      if (dat.error) throw new Error(`Polymer: ${dat.error}`);
      polymerIndex = dat.polymerIndex;
      if (dat.proof) {
        proof = dat.proof;
        break;
      }
    }
    if (!proof) {
      throw new Error(
        `Polymer proof unavailable for output on chain ${output.chainId}. Try again after the fill attestation is indexed.`,
      );
    }
    const txHash = await walletClient.writeContract({
      chain: sourceChain,
      account,
      address: inputOracle,
      abi: POLYMER_ORACLE_ABI,
      functionName: "receiveMessage",
      args: [`0x${proof.replace("0x", "")}`],
    });
    await sourceClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });
    return txHash;
  }

  // Same-chain: setAttestation via COIN_FILLER
  if (inputOracle.toLowerCase() === COIN_FILLER.toLowerCase()) {
    const log = logs.find((l) => l.logIndex === logIndex)!;
    const txHash = await walletClient.writeContract({
      chain: sourceChain,
      account,
      address: inputOracle,
      abi: COIN_FILLER_ABI,
      functionName: "setAttestation",
      args: [
        log.args.orderId,
        log.args.solver,
        log.args.timestamp,
        log.args.output,
      ],
    });
    await sourceClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });
    return txHash;
  }

  throw new Error(
    `Unsupported input oracle ${inputOracle} for source chain ${sourceChainId}.`,
  );
}

export async function claimEvmInputs(params: {
  walletClient: WalletClient;
  container: OrderContainer;
  fillTransactionRefs: string[];
  fillRecordKeys: string[];
  sourceChainId: number;
  account: `0x${string}`;
  getFillRecord: (key: string) => SolanaFillRecord | undefined;
}): Promise<`0x${string}`> {
  const {
    walletClient,
    container,
    fillTransactionRefs,
    fillRecordKeys,
    sourceChainId,
    account,
    getFillRecord,
  } = params;
  const { order, inputSettler } = container;

  if (fillTransactionRefs.length !== order.outputs.length) {
    throw new Error(
      `Fill transaction ref count (${fillTransactionRefs.length}) does not match output count (${order.outputs.length}).`,
    );
  }

  const solveParams = await Promise.all(
    order.outputs.map(async (output, i) => {
      const txRef = fillTransactionRefs[i];
      if (!txRef)
        throw new Error(`Missing fill transaction reference at index ${i}`);

      if (isSolanaViemChainId(output.chainId)) {
        const recordKey = fillRecordKeys[i];
        if (!recordKey)
          throw new Error(`Missing fill record key at index ${i}`);
        const record = getFillRecord(recordKey);
        if (!record || !isSolanaSubmittedFillRecord(record)) {
          throw new Error(`Missing Solana fill metadata at index ${i}`);
        }
        return {
          timestamp: record.fillTimestamp,
          solver: record.solverBytes32 as `0x${string}`,
        };
      }

      if (!txRef.startsWith("0x") || txRef.length !== 66) {
        throw new Error(`Invalid fill tx hash at index ${i}: ${txRef}`);
      }

      const receipt = await getEvmClient(
        Number(output.chainId),
      ).getTransactionReceipt({
        hash: txRef as `0x${string}`,
      });
      const logs = parseEventLogs({
        abi: COIN_FILLER_ABI,
        eventName: "OutputFilled",
        logs: receipt.logs,
      });
      const expectedOutputHash = hashStruct({
        types: compactTypes,
        primaryType: "MandateOutput",
        data: output,
      });
      const matchingLog = logs.find((log) => {
        const h = hashStruct({
          types: compactTypes,
          primaryType: "MandateOutput",
          data: log.args.output,
        });
        return h === expectedOutputHash;
      });
      if (!matchingLog)
        throw new Error(
          `Could not find matching OutputFilled log for output ${i}`,
        );

      return {
        timestamp: Number(matchingLog.args.timestamp),
        solver: matchingLog.args.solver as `0x${string}`,
      };
    }),
  );

  const sourceChain = getEvmChain(sourceChainId);
  const sourceClient = getEvmClient(sourceChainId);

  await ensureWalletOnChain(walletClient, sourceChainId);

  const destination = addressToBytes32(toEvmAddress(account));

  // Determine settler type and call finalise
  if (inputSettler.toLowerCase() === INPUT_SETTLER_ESCROW_LIFI.toLowerCase()) {
    const txHash = await walletClient.writeContract({
      chain: sourceChain,
      account,
      address: inputSettler as `0x${string}`,
      abi: SETTLER_ESCROW_ABI,
      functionName: "finalise",
      args: [order as never, solveParams as never, destination, "0x"],
    });
    await sourceClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });
    return txHash;
  }

  if (inputSettler.toLowerCase() === INPUT_SETTLER_COMPACT_LIFI.toLowerCase()) {
    const { encodeAbiParameters, parseAbiParameters } = await import("viem");
    const combinedSigs = encodeAbiParameters(
      parseAbiParameters(["bytes", "bytes"]),
      [
        container.sponsorSignature.payload,
        container.allocatorSignature.payload,
      ],
    );
    // Compact ABI finalise: (order, signatures, solveParams, destination, hint)
    const txHash = await walletClient.writeContract({
      chain: sourceChain,
      account,
      address: inputSettler as `0x${string}`,
      abi: SETTLER_ESCROW_ABI as never,
      functionName: "finalise",
      args: [
        order as never,
        combinedSigs as never,
        solveParams as never,
        destination,
        "0x",
      ],
    });
    await sourceClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });
    return txHash;
  }

  throw new Error(`Unsupported input settler ${inputSettler}`);
}
