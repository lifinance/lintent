"use client";
import { type ReactElement, useEffect } from "react";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import { useSvmBalance } from "../../hooks/svm/useSvmBalances";

type SvmInputBalanceRowProps = {
  tokenName: string;
  tokenDecimals: number;
  mintBytes32: `0x${string}`;
  amount: bigint;
  publicKey: string | null;
  onBalanceLoaded?: (balance: bigint | undefined) => void;
};

function formatAmount(amount: bigint, decimals: number): string {
  return (Number(amount) / 10 ** decimals).toFixed(4);
}

export function SvmInputBalanceRow({
  tokenName,
  tokenDecimals,
  mintBytes32,
  amount,
  publicKey,
  onBalanceLoaded,
}: SvmInputBalanceRowProps): ReactElement {
  const { balance, isLoading } = useSvmBalance(publicKey, mintBytes32);

  useEffect(() => {
    onBalanceLoaded?.(balance);
  }, [balance, onBalanceLoaded]);

  const insufficient = balance !== undefined && amount > 0n && balance < amount;

  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="body2">
        <strong>{formatAmount(amount, tokenDecimals)} {tokenName}</strong>
        {" on Solana"}
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
