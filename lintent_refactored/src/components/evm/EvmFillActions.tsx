"use client";
import { type ReactElement } from "react";

import { useState } from "react";
import { useWalletClient, useConfig } from "wagmi";
import { getWalletClient, getAccount } from "@wagmi/core";
import type { Config } from "wagmi";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import { AppButton } from "../shared/ui/AppButton";
import { AppCard } from "../shared/ui/AppCard";
import { isAddress } from "viem";
import { addressToBytes32 } from "@lifi/intent";
import { toEvmAddress } from "../../lib/config/shared";
import { fillEvmOutputs, validateEvmFill, claimEvmInputs } from "../../lib/solver/evm";
import { fillSolanaOutput, submitFilledSolanaOutput } from "../../lib/solver/svm";
import { useOrdersStore } from "../../store/orders.ts";
import { useSelectionStore } from "../../store/selection.ts";
import { isSolanaViemChainId, formatChainLabel } from "../../lib/config/svm.ts";
import { useSwitchChain } from "wagmi";
import {
  isSolanaSubmittedFillRecord,
  type OrderContainer,
  type MandateOutput,
} from "../../types/shared";
import type { SigningWalletAdapter } from "../../lib/solver/anchorTypes";

type EvmFillActionsProps = {
  order: OrderContainer;
  fillerAddress: `0x${string}` | undefined;
  onClaimed?: () => void;
};

type StepState = "pending" | "running" | "done" | "error";

function groupOutputsByChain(outputs: MandateOutput[]): Map<bigint, MandateOutput[]> {
  const map = new Map<bigint, MandateOutput[]>();
  for (const output of outputs) {
    const existing = map.get(output.chainId) ?? [];
    map.set(output.chainId, [...existing, output]);
  }
  return map;
}

function getSourceChainId(order: OrderContainer): number {
  if (order.order.kind === "standard") return Number(order.order.originChainId);
  if (order.order.kind === "multichain") return Number(order.order.inputs[0]?.chainId ?? 0n);
  return 0;
}

/**
 * Switch the connected wallet to `targetChainId` and return a WalletClient
 * bound to that chain. Polls `getWalletClient` (not `getAccount`) because
 * wagmi's account state can reflect the new chain before the underlying
 * connector's chainChanged event propagates — polling the actual client
 * acquisition is the only reliable signal that the switch has fully settled.
 */
async function switchAndGetWalletClient(
  config: Config,
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>,
  targetChainId: number,
): Promise<Awaited<ReturnType<typeof getWalletClient>>> {
  const tryGet = async (): Promise<Awaited<ReturnType<typeof getWalletClient>> | null> => {
    try {
      return await getWalletClient(config, { chainId: targetChainId });
    } catch {
      return null;
    }
  };

  if (getAccount(config).chainId === targetChainId) {
    const client = await tryGet();
    if (client) return client;
  }

  await switchChainAsync({ chainId: targetChainId });

  for (let i = 0; i < 40; i++) {
    const client = await tryGet();
    if (client) return client;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Wallet did not switch to chain ${targetChainId} within 10s. ` +
      `Please switch manually in your wallet and try again.`,
  );
}

export function EvmFillActions({ order, fillerAddress, onClaimed }: EvmFillActionsProps): ReactElement {
  const { data: walletClient } = useWalletClient();
  const config = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const wallet = useWallet();
  const { connection } = useConnection();
  const { mainnet } = useSelectionStore();
  const { fillTransactions, setFillTransaction, setFillRecord, getFillRecord, markOrderClaimed } = useOrdersStore();
  const grouped = groupOutputsByChain(order.order.outputs);

  const [fillRunning, setFillRunning] = useState<Record<string, boolean>>({});
  const [submitRunning, setSubmitRunning] = useState<Record<string, boolean>>({});
  const [validateState, setValidateState] = useState<StepState>("pending");
  const [claimState, setClaimState] = useState<StepState>("pending");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [solverAddress, setSolverAddress] = useState("");

  const hasSolanaOutputs = order.order.outputs.some(
    (o) => isSolanaViemChainId(o.chainId),
  );

  // A chain is "filled" iff every output on that chain has a fill tx recorded.
  const chainGlobalIndices = (chainId: bigint): number[] => {
    const indices: number[] = [];
    order.order.outputs.forEach((o, i) => {
      if (o.chainId === chainId) indices.push(i);
    });
    return indices;
  };
  const isChainFilled = (chainId: bigint): boolean => {
    const indices = chainGlobalIndices(chainId);
    return indices.length > 0 && indices.every((i) => !!fillTransactions[`${order.orderId}-${i}`]);
  };
  const isSolanaChainSubmitted = (chainId: bigint): boolean => {
    const indices = chainGlobalIndices(chainId);
    return indices.length > 0 && indices.every((i) => {
      const record = getFillRecord(`${order.orderId}-${i}`);
      return !!record && isSolanaSubmittedFillRecord(record);
    });
  };
  const allFilled = order.order.outputs.every(
    (_, i) => fillTransactions[`${order.orderId}-${i}`],
  );
  const allSolanaOutputsSubmitted = order.order.outputs.every((output, index) => {
    if (!isSolanaViemChainId(output.chainId)) return true;
    const record = getFillRecord(`${order.orderId}-${index}`);
    return !!record && isSolanaSubmittedFillRecord(record);
  });

  const handleFillEvm = async (chainId: bigint, outputs: MandateOutput[]): Promise<void> => {
    if (!fillerAddress || !walletClient) return;
    const chainKey = chainId.toString();
    setFillRunning((s) => ({ ...s, [chainKey]: true }));
    setErrorMsg(null);
    try {
      const targetChainId = Number(chainId);
      const freshWalletClient = await switchAndGetWalletClient(config, switchChainAsync, targetChainId);
      const solverBytes32 = solverAddress && isAddress(solverAddress, { strict: false })
        ? addressToBytes32(toEvmAddress(solverAddress))
        : undefined;
      const txHash = await fillEvmOutputs({
        walletClient: freshWalletClient,
        orderId: order.orderId as `0x${string}`,
        outputs,
        fillDeadline: order.order.fillDeadline,
        account: fillerAddress,
        solverBytes32,
      });
      // Only mark outputs that actually belong to this chain as filled. Index
      // by identity in the outputs array so interleaved orders stay correct.
      for (const output of outputs) {
        const globalIndex = order.order.outputs.indexOf(output);
        if (globalIndex >= 0) {
          setFillTransaction(`${order.orderId}-${globalIndex}`, txHash);
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Fill failed");
    } finally {
      setFillRunning((s) => ({ ...s, [chainKey]: false }));
    }
  };

  const handleFillSolana = async (chainId: bigint): Promise<void> => {
    if (!wallet.wallet?.adapter || !wallet.publicKey || !fillerAddress) return;
    const chainKey = chainId.toString();
    setFillRunning((s) => ({ ...s, [chainKey]: true }));
    setErrorMsg(null);
    try {
      const solverBytes32 = solverAddress && isAddress(solverAddress, { strict: false })
        ? addressToBytes32(toEvmAddress(solverAddress))
        : addressToBytes32(toEvmAddress(fillerAddress));
      const solanaIndices = chainGlobalIndices(chainId);
      for (let i = 0; i < solanaIndices.length; i++) {
        const globalIndex = solanaIndices[i];
        if (globalIndex === undefined) continue;
        const output = order.order.outputs[globalIndex];
        if (!output) continue;
        const record = await fillSolanaOutput({
          orderId: order.orderId as `0x${string}`,
          output,
          fillDeadline: order.order.fillDeadline,
          solverBytes32,
          solanaPublicKey: wallet.publicKey.toBase58(),
          walletAdapter: wallet.wallet.adapter as SigningWalletAdapter,
          connection,
          mainnet,
        });
        setFillRecord(`${order.orderId}-${globalIndex}`, record);
        setFillTransaction(`${order.orderId}-${globalIndex}`, record.fillSignature);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Solana fill failed");
    } finally {
      setFillRunning((s) => ({ ...s, [chainKey]: false }));
    }
  };

  const handleSubmitSolana = async (chainId: bigint): Promise<void> => {
    if (!wallet.wallet?.adapter || !wallet.publicKey) return;
    const chainKey = chainId.toString();
    setSubmitRunning((s) => ({ ...s, [chainKey]: true }));
    setErrorMsg(null);
    try {
      const solanaIndices = chainGlobalIndices(chainId);
      for (const globalIndex of solanaIndices) {
        const output = order.order.outputs[globalIndex];
        const recordKey = `${order.orderId}-${globalIndex}`;
        const record = getFillRecord(recordKey);
        if (!output || !record) {
          throw new Error("Missing Solana fill metadata. Fill the output before submitting.");
        }
        if (isSolanaSubmittedFillRecord(record)) continue;
        const submittedRecord = await submitFilledSolanaOutput({
          record,
          output,
          solanaPublicKey: wallet.publicKey.toBase58(),
          walletAdapter: wallet.wallet.adapter as SigningWalletAdapter,
          connection,
          mainnet,
        });
        setFillRecord(recordKey, submittedRecord);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Solana submit failed");
    } finally {
      setSubmitRunning((s) => ({ ...s, [chainKey]: false }));
    }
  };

  const handleValidate = async (): Promise<void> => {
    if (!fillerAddress || !walletClient) return;
    setValidateState("running");
    setErrorMsg(null);
    try {
      const sourceChainId = getSourceChainId(order);
      const freshWalletClient = await switchAndGetWalletClient(config, switchChainAsync, sourceChainId);
      for (let i = 0; i < order.order.outputs.length; i++) {
        const output = order.order.outputs[i];
        const recordKey = `${order.orderId}-${i}`;
        const fillTxRef = fillTransactions[recordKey];
        if (!fillTxRef) throw new Error(`Missing fill tx for output ${i}`);
        await validateEvmFill({
          walletClient: freshWalletClient,
          output,
          fillTransactionRef: fillTxRef,
          fillRecordKey: recordKey,
          inputOracle: order.order.inputOracle as `0x${string}`,
          sourceChainId,
          mainnet,
          account: fillerAddress,
          getFillRecord,
        });
      }
      setValidateState("done");
    } catch (err) {
      setValidateState("error");
      setErrorMsg(err instanceof Error ? err.message : "Validation failed");
    }
  };

  const handleClaim = async (): Promise<void> => {
    if (!fillerAddress || !walletClient) return;
    setClaimState("running");
    setErrorMsg(null);
    try {
      const sourceChainId = getSourceChainId(order);
      const freshWalletClient = await switchAndGetWalletClient(config, switchChainAsync, sourceChainId);
      const recordKeys = order.order.outputs.map((_, i) => `${order.orderId}-${i}`);
      const fillRefs = recordKeys.map((key) => fillTransactions[key] ?? "");
      await claimEvmInputs({
        walletClient: freshWalletClient,
        container: order,
        fillTransactionRefs: fillRefs,
        fillRecordKeys: recordKeys,
        sourceChainId,
        account: fillerAddress,
        getFillRecord,
      });
      markOrderClaimed(order.orderId);
      setClaimState("done");
      onClaimed?.();
    } catch (err) {
      setClaimState("error");
      setErrorMsg(err instanceof Error ? err.message : "Claim failed");
    }
  };

  const isSolanaChain = (chainId: bigint): boolean =>
    isSolanaViemChainId(chainId);

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2" color="text.secondary">
        Solver Actions
      </Typography>
      {fillerAddress && (
        <Typography variant="caption" color="text.disabled">
          Filling as: {fillerAddress.slice(0, 6)}…{fillerAddress.slice(-4)}
        </Typography>
      )}

      {hasSolanaOutputs && (
        <TextField
          size="small"
          fullWidth
          label="Solver Address (optional)"
          placeholder="0x... (defaults to connected wallet)"
          value={solverAddress}
          onChange={(e) => setSolverAddress(e.target.value)}
          error={solverAddress.length > 0 && !isAddress(solverAddress, { strict: false })}
          helperText={
            solverAddress.length > 0 && !isAddress(solverAddress, { strict: false })
              ? "Enter a valid EVM address"
              : "EVM address used as the solver identity for claiming"
          }
        />
      )}

      {/* Step 1: Fill per chain */}
      {Array.from(grouped.entries()).map(([chainId, outputs]) => (
        <AppCard key={chainId.toString()} sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Stack spacing={0.5}>
              <Typography variant="caption" color="text.secondary">
                {formatChainLabel(chainId)}
              </Typography>
              <Typography variant="body2">
                {outputs.length} output{outputs.length !== 1 ? "s" : ""}
              </Typography>
            </Stack>
            {isSolanaChain(chainId) ? (
              <Stack direction="row" spacing={1} alignItems="center">
                {isSolanaChainSubmitted(chainId) && (
                  <Typography variant="body2" color="success.main" fontWeight={600}>
                    Submitted
                  </Typography>
                )}
                <AppButton
                  size="small"
                  variant="contained"
                  color="secondary"
                  loading={!!fillRunning[chainId.toString()]}
                  disabled={!wallet.connected || !wallet.publicKey || isChainFilled(chainId)}
                  onClick={() => void handleFillSolana(chainId)}
                >
                  Fill (Solana)
                </AppButton>
                <AppButton
                  size="small"
                  variant="outlined"
                  loading={!!submitRunning[chainId.toString()]}
                  disabled={!wallet.connected || !wallet.publicKey || !isChainFilled(chainId) || isSolanaChainSubmitted(chainId)}
                  onClick={() => void handleSubmitSolana(chainId)}
                >
                  Submit
                </AppButton>
              </Stack>
            ) : isChainFilled(chainId) ? (
              <Typography variant="body2" color="success.main" fontWeight={600}>Filled</Typography>
            ) : (
              <AppButton
                size="small"
                variant="contained"
                loading={!!fillRunning[chainId.toString()]}
                disabled={!fillerAddress}
                onClick={() => void handleFillEvm(chainId, outputs)}
              >
                Fill
              </AppButton>
            )}
          </Stack>
        </AppCard>
      ))}

      {/* Step 2: Validate */}
      <AppCard sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="body2">Prove fills (Polymer)</Typography>
          {validateState === "done" ? (
            <Typography variant="body2" color="success.main" fontWeight={600}>Validated</Typography>
          ) : (
            <AppButton
              size="small"
              variant="outlined"
              loading={validateState === "running"}
              disabled={!allFilled || !allSolanaOutputsSubmitted}
              onClick={() => void handleValidate()}
            >
              Validate
            </AppButton>
          )}
        </Stack>
      </AppCard>

      {/* Step 3: Claim */}
      <AppCard sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="body2">Claim input tokens</Typography>
          {claimState === "done" ? (
            <Typography variant="body2" color="success.main" fontWeight={600}>Claimed</Typography>
          ) : (
            <AppButton
              size="small"
              variant="outlined"
              loading={claimState === "running"}
              disabled={validateState !== "done"}
              onClick={() => void handleClaim()}
            >
              Claim
            </AppButton>
          )}
        </Stack>
      </AppCard>

      {errorMsg && (
        <Typography variant="caption" color="error">{errorMsg}</Typography>
      )}
      <Divider />
    </Stack>
  );
}
