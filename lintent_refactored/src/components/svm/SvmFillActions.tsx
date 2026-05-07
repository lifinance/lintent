"use client";
import { type ReactElement } from "react";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useWalletClient } from "wagmi";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import { AppButton } from "../shared/ui/AppButton.tsx";
import { AppCard } from "../shared/ui/AppCard.tsx";
import { fillEvmOutputs, validateEvmFill } from "../../lib/solver/evm.ts";
import {
  fillAndSubmitSolanaOutputs,
  submitProofAndFinalizeSolanaEscrow,
} from "../../lib/solver/svm.ts";
import { submitProofToSolanaOracle } from "../../lib/solver/solanaValidate.ts";
import { useOrdersStore } from "../../store/orders.ts";
import { useSelectionStore } from "../../store/selection.ts";
import { isSolanaViemChainId, formatChainLabel } from "../../lib/config/svm.ts";
import { isSolanaAddress, solanaAddressToBytes32 } from "../../lib/config/shared.ts";
import { addressToBytes32, toEvmAddress } from "../../lib/config/shared.ts";
import type { MandateOutput, OrderContainer } from "../../types/shared.ts";
import type { SigningWalletAdapter } from "../../lib/solver/anchorTypes.ts";

type SvmFillActionsProps = {
  order: OrderContainer;
  fillerPublicKey: string | null;
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

function isSolanaOrder(order: OrderContainer): boolean {
  return order.vm === "svm";
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const maybe = error as {
      message?: unknown;
      cause?: { message?: unknown };
      error?: { message?: unknown };
      logs?: unknown;
    };
    if (typeof maybe.message === "string" && maybe.message.length > 0) {
      return maybe.message;
    }
    if (typeof maybe.cause?.message === "string" && maybe.cause.message.length > 0) {
      return maybe.cause.message;
    }
    if (typeof maybe.error?.message === "string" && maybe.error.message.length > 0) {
      return maybe.error.message;
    }
    try {
      const serialised = JSON.stringify(error);
      if (serialised && serialised !== "{}") return serialised;
    } catch {}
  }
  return fallback;
}

export function SvmFillActions({ order, fillerPublicKey, onClaimed }: SvmFillActionsProps): ReactElement {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { data: evmWalletClient } = useWalletClient();
  const { mainnet } = useSelectionStore();
  const { fillTransactions, setFillTransaction, setFillRecord, getFillRecord, markOrderClaimed } = useOrdersStore();
  const grouped = groupOutputsByChain(order.order.outputs);

  const [fillState, setFillState] = useState<StepState>("pending");
  const [validateState, setValidateState] = useState<StepState>("pending");
  const [claimState, setClaimState] = useState<StepState>("pending");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [solanaSolverAddress, setSolanaSolverAddress] = useState("");

  const allFilled = order.order.outputs.every(
    (_, i) => fillTransactions[`${order.orderId}-${i}`],
  );

  const handleFillSolanaOutputs = async (): Promise<void> => {
    if (!fillerPublicKey || !wallet.wallet?.adapter) return;
    setFillState("running");
    setErrorMsg(null);
    try {
      const solverBytes32 = addressToBytes32(toEvmAddress(fillerPublicKey));
      const records = await fillAndSubmitSolanaOutputs({
        container: order,
        solverBytes32: solverBytes32 as `0x${string}`,
        solanaPublicKey: fillerPublicKey,
        walletAdapter: wallet.wallet.adapter as SigningWalletAdapter,
        connection,
        mainnet,
      });
      for (let i = 0; i < records.length; i++) {
        setFillRecord(`${order.orderId}-${i}`, records[i]);
        setFillTransaction(`${order.orderId}-${i}`, records[i].fillSignature);
      }
      setFillState("done");
    } catch (err) {
      setFillState("error");
      setErrorMsg(getErrorMessage(err, "Solana fill failed"));
    }
  };

  const handleFillEvmOutputs = async (chainId: bigint, outputs: MandateOutput[]): Promise<void> => {
    if (!evmWalletClient) return;
    setFillState("running");
    setErrorMsg(null);
    try {
      const account = evmWalletClient.account.address;
      // Use the entered address if valid; otherwise fall back to the connected
      // Solana wallet so the user does not need to retype their own pubkey.
      const effectiveSolver = isSolanaAddress(solanaSolverAddress)
        ? solanaSolverAddress
        : (fillerPublicKey ?? "");
      const solverBytes32 = isSolanaAddress(effectiveSolver)
        ? solanaAddressToBytes32(effectiveSolver) as `0x${string}`
        : undefined;
      const txHash = await fillEvmOutputs({
        walletClient: evmWalletClient,
        orderId: order.orderId as `0x${string}`,
        outputs,
        fillDeadline: order.order.fillDeadline,
        account,
        solverBytes32,
      });
      const baseIndex = order.order.outputs.findIndex((o) => o.chainId === chainId);
      for (let i = 0; i < outputs.length; i++) {
        setFillTransaction(`${order.orderId}-${baseIndex + i}`, txHash);
      }
      setFillState("done");
    } catch (err) {
      setFillState("error");
      setErrorMsg(getErrorMessage(err, "EVM fill failed"));
    }
  };

  const handleValidateSolanaInput = async (): Promise<void> => {
    if (!evmWalletClient || !fillerPublicKey || !wallet.wallet?.adapter) return;
    setValidateState("running");
    setErrorMsg(null);
    try {
      for (let i = 0; i < order.order.outputs.length; i++) {
        const output = order.order.outputs[i];
        const fillTxHash = fillTransactions[`${order.orderId}-${i}`];
        if (!fillTxHash) throw new Error(`Missing fill tx for output ${i}`);

        const { getEvmClient } = await import("../../lib/config/evm.ts");
        const receipt = await getEvmClient(Number(output.chainId)).getTransactionReceipt({
          hash: fillTxHash as `0x${string}`,
        });

        const { parseEventLogs } = await import("viem");
        const { COIN_FILLER_ABI } = await import("../../lib/abi/outputSettler.ts");
        const logs = parseEventLogs({
          abi: COIN_FILLER_ABI,
          eventName: "OutputFilled",
          logs: receipt.logs,
        });
        if (logs.length === 0) throw new Error(`No OutputFilled log for output ${i}`);
        const log = logs[0];

        await submitProofToSolanaOracle({
          evmChainId: output.chainId,
          output,
          orderId: order.orderId as `0x${string}`,
          fillTimestamp: Number(log.args.timestamp),
          solverBytes32: log.args.solver as `0x${string}`,
          fillBlockNumber: Number(receipt.blockNumber),
          globalLogIndex: log.logIndex,
          mainnet,
          solanaPublicKey: fillerPublicKey,
          walletAdapter: wallet.wallet.adapter as SigningWalletAdapter,
          connection,
        });
      }
      setValidateState("done");
    } catch (err) {
      setValidateState("error");
      setErrorMsg(getErrorMessage(err, "Validation failed"));
    }
  };

  const handleValidateEvmInput = async (): Promise<void> => {
    if (!evmWalletClient) return;
    setValidateState("running");
    setErrorMsg(null);
    try {
      const account = evmWalletClient.account.address;
      const sourceChainId = order.order.kind === "standard"
        ? Number(order.order.originChainId)
        : order.order.kind === "multichain"
          ? Number(order.order.inputs[0]?.chainId ?? 0n)
          : 0;

      for (let i = 0; i < order.order.outputs.length; i++) {
        const output = order.order.outputs[i];
        const recordKey = `${order.orderId}-${i}`;
        const fillTxRef = fillTransactions[recordKey];
        if (!fillTxRef) throw new Error(`Missing fill tx for output ${i}`);
        await validateEvmFill({
          walletClient: evmWalletClient,
          output,
          fillTransactionRef: fillTxRef,
          fillRecordKey: recordKey,
          inputOracle: order.order.inputOracle as `0x${string}`,
          sourceChainId,
          mainnet,
          account,
          getFillRecord,
        });
      }
      setValidateState("done");
    } catch (err) {
      setValidateState("error");
      setErrorMsg(getErrorMessage(err, "Validation failed"));
    }
  };

  const handleClaimSolana = async (): Promise<void> => {
    if (!fillerPublicKey || !wallet.wallet?.adapter) return;
    setClaimState("running");
    setErrorMsg(null);
    try {
      const fillHashes = order.order.outputs.map(
        (_, i) => fillTransactions[`${order.orderId}-${i}`] ?? "",
      );
      await submitProofAndFinalizeSolanaEscrow({
        container: order,
        fillTransactionHashes: fillHashes,
        solanaPublicKey: fillerPublicKey,
        walletAdapter: wallet.wallet.adapter as SigningWalletAdapter,
        connection,
        mainnet,
      });
      markOrderClaimed(order.orderId);
      setClaimState("done");
      onClaimed?.();
    } catch (err) {
      setClaimState("error");
      setErrorMsg(getErrorMessage(err, "Claim failed"));
    }
  };

  const solanaInput = isSolanaOrder(order);
  const hasSolanaOutputs = order.order.outputs.some(
    (o) => isSolanaViemChainId(o.chainId),
  );

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2" color="text.secondary">
        Solver Actions {solanaInput ? "(Solana Input)" : "(Solana Output)"}
      </Typography>
      {fillerPublicKey && (
        <Typography variant="caption" color="text.disabled">
          Filling as: {fillerPublicKey.slice(0, 6)}…{fillerPublicKey.slice(-4)}
        </Typography>
      )}

      {solanaInput && (
        <TextField
          size="small"
          fullWidth
          label="Solana Solver Address (optional)"
          placeholder={`Defaults to ${fillerPublicKey ? `${fillerPublicKey.slice(0, 4)}…${fillerPublicKey.slice(-4)}` : "connected Solana wallet"}`}
          value={solanaSolverAddress}
          onChange={(e) => setSolanaSolverAddress(e.target.value)}
          error={solanaSolverAddress.length > 0 && !isSolanaAddress(solanaSolverAddress)}
          helperText={
            solanaSolverAddress.length > 0 && !isSolanaAddress(solanaSolverAddress)
              ? "Enter a valid base58 Solana address"
              : "Leave blank to use the connected Solana wallet."
          }
        />
      )}

      {/* Fill step */}
      {solanaInput ? (
        Array.from(grouped.entries()).map(([chainId, outputs]) => (
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
              {fillState === "done" ? (
                <Typography variant="body2" color="success.main" fontWeight={600}>Filled</Typography>
              ) : (
                <AppButton
                  size="small"
                  variant="contained"
                  color="secondary"
                  loading={fillState === "running"}
                  disabled={
                    !evmWalletClient ||
                    !(
                      isSolanaAddress(solanaSolverAddress) ||
                      (solanaSolverAddress.length === 0 && !!fillerPublicKey)
                    )
                  }
                  onClick={() => void handleFillEvmOutputs(chainId, outputs)}
                >
                  Fill (EVM)
                </AppButton>
              )}
            </Stack>
          </AppCard>
        ))
      ) : hasSolanaOutputs ? (
        <AppCard sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2">Fill Solana outputs</Typography>
            {fillState === "done" ? (
              <Typography variant="body2" color="success.main" fontWeight={600}>Filled</Typography>
            ) : (
              <AppButton
                size="small"
                variant="contained"
                color="secondary"
                loading={fillState === "running"}
                disabled={!fillerPublicKey}
                onClick={() => void handleFillSolanaOutputs()}
              >
                Fill (Solana)
              </AppButton>
            )}
          </Stack>
        </AppCard>
      ) : null}

      {/* Validate step */}
      <AppCard sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="body2">
            {solanaInput ? "Prove fills (Solana Oracle)" : "Prove fills (EVM Polymer)"}
          </Typography>
          {validateState === "done" ? (
            <Typography variant="body2" color="success.main" fontWeight={600}>Validated</Typography>
          ) : (
            <AppButton
              size="small"
              variant="outlined"
              color="secondary"
              loading={validateState === "running"}
              disabled={!allFilled}
              onClick={() => void (solanaInput ? handleValidateSolanaInput() : handleValidateEvmInput())}
            >
              Validate
            </AppButton>
          )}
        </Stack>
      </AppCard>

      {/* Claim step */}
      <AppCard sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="body2">
            {solanaInput ? "Finalise Solana escrow" : "Claim inputs (EVM)"}
          </Typography>
          {claimState === "done" ? (
            <Typography variant="body2" color="success.main" fontWeight={600}>Claimed</Typography>
          ) : (
            <AppButton
              size="small"
              variant="outlined"
              color="secondary"
              loading={claimState === "running"}
              disabled={validateState !== "done"}
              onClick={() => void handleClaimSolana()}
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
