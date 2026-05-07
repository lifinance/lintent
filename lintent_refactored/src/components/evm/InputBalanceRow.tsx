"use client";
import { type ReactElement, useEffect } from "react";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import { useEvmBalance } from "../../hooks/evm/useEvmBalances";
import { getEvmChain } from "../../lib/config/evm";

type InputBalanceRowProps = {
  chainId: number;
  tokenAddress: string;
  tokenName: string;
  tokenDecimals: number;
  amount: bigint;
  userAddress: `0x${string}` | undefined;
  onBalanceLoaded?: (chainId: number, balance: bigint | undefined) => void;
};

function formatAmount(amount: bigint, decimals: number): string {
  return (Number(amount) / 10 ** decimals).toFixed(4);
}

export function EvmInputBalanceRow({
  chainId,
  tokenAddress,
  tokenName,
  tokenDecimals,
  amount,
  userAddress,
  onBalanceLoaded,
}: InputBalanceRowProps): ReactElement {
  const { balance, isLoading } = useEvmBalance(
    userAddress,
    tokenAddress as `0x${string}`,
    chainId,
  );

  useEffect(() => {
    onBalanceLoaded?.(chainId, balance);
  }, [chainId, balance, onBalanceLoaded]);

  let chainName: string;
  try {
    chainName = getEvmChain(chainId).name;
  } catch {
    chainName = `Chain ${chainId}`;
  }

  const insufficient = balance !== undefined && amount > 0n && balance < amount;

  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="body2">
        <strong>{formatAmount(amount, tokenDecimals)} {tokenName}</strong>
        {" on "}
        {chainName}
      </Typography>
      <Typography
        variant="caption"
        color={insufficient ? "error" : "text.secondary"}
        sx={{ whiteSpace: "nowrap", ml: 1 }}
      >
        {isLoading ? (
          <CircularProgress size={12} />
        ) : balance !== undefined ? (
          `Bal: ${formatAmount(balance, tokenDecimals)}`
        ) : (
          "—"
        )}
      </Typography>
    </Stack>
  );
}
