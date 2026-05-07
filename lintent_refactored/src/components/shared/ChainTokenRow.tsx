"use client";
import { type ReactElement, useEffect, useState } from "react";

import Stack from "@mui/material/Stack";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import { getEvmChains, getEvmTokensForChain } from "../../lib/config/evm.ts";
import { getSvmTokens, getSvmViemChainId } from "../../lib/config/svm.ts";
import type { Vm } from "../../types/shared.ts";

type ChainTokenRowProps = {
  vm: Vm;
  chainId: number;
  tokenAddress: string;
  amount: bigint;
  tokenDecimals: number;
  mainnet: boolean;
  showChainSelector: boolean;
  disabledChainIds?: number[];
  onChainChange: (chainId: number) => void;
  onTokenChange: (address: string, name: string, decimals: number) => void;
  onAmountChange: (amount: bigint) => void;
};

function toDisplayAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return "";
  const divisor = 10 ** decimals;
  return (Number(amount) / divisor).toString();
}

function fromDisplayAmount(value: string, decimals: number): bigint {
  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed < 0) return 0n;
  return BigInt(Math.floor(parsed * 10 ** decimals));
}

export function ChainTokenRow({
  vm,
  chainId,
  tokenAddress,
  amount,
  tokenDecimals,
  mainnet,
  showChainSelector,
  disabledChainIds = [],
  onChainChange,
  onTokenChange,
  onAmountChange,
}: ChainTokenRowProps): ReactElement {
  const evmChains = getEvmChains(mainnet);
  const solanaViemChainId = getSvmViemChainId(mainnet);
  const solanaLabel = mainnet ? "Solana" : "Solana Devnet";

  const tokens =
    vm === "svm"
      ? getSvmTokens(mainnet).map((t) => ({ address: t.bytes32Address, name: t.name, decimals: t.decimals }))
      : getEvmTokensForChain(chainId, mainnet).map((t) => ({
          address: t.address,
          name: t.name,
          decimals: t.decimals,
        }));

  // Local controlled-input string so in-progress typing like "0", "0.", "0.0"
  // is preserved while the parent's `amount` (a bigint) is the source of
  // truth for downstream logic. Re-syncing from props on every render would
  // round-trip "0." → 0n → "" and erase the user's keystroke mid-entry.
  const [amountInput, setAmountInput] = useState<string>(() =>
    toDisplayAmount(amount, tokenDecimals),
  );

  // Re-sync the displayed string when the parent's amount or decimals change
  // *externally* (token swap, chain swap, programmatic reset). We detect
  // "external" by checking whether parsing the local string already yields
  // the parent value — if it does, the local string is the canonical
  // representation and we leave it alone.
  useEffect(() => {
    if (fromDisplayAmount(amountInput, tokenDecimals) !== amount) {
      setAmountInput(toDisplayAmount(amount, tokenDecimals));
    }
    // amountInput intentionally omitted: we only re-sync on parent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, tokenDecimals]);

  // Fixed widths keep every row aligned regardless of chain/token name length;
  // the selected label truncates with an ellipsis if it overflows.
  const truncateSelected = {
    "& .MuiSelect-select": {
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
  } as const;

  return (
    <Stack direction="row" spacing={1} alignItems="flex-end">
      {showChainSelector && (
        <FormControl size="small" sx={{ width: 150, flexShrink: 0 }}>
          <InputLabel>Chain</InputLabel>
          <Select
            value={chainId}
            label="Chain"
            onChange={(e) => onChainChange(Number(e.target.value))}
            sx={truncateSelected}
          >
            {vm === "svm" ? (
              <MenuItem value={solanaViemChainId}>{solanaLabel}</MenuItem>
            ) : (
              evmChains.map((c) => (
                <MenuItem key={c.id} value={c.id} disabled={disabledChainIds.includes(c.id)}>
                  {c.name}
                </MenuItem>
              ))
            )}
          </Select>
        </FormControl>
      )}

      <FormControl size="small" sx={{ width: 100, flexShrink: 0 }}>
        <InputLabel>Token</InputLabel>
        <Select
          value={tokenAddress}
          label="Token"
          onChange={(e) => {
            const token = tokens.find((t) => t.address === e.target.value);
            if (!token) return;
            onTokenChange(token.address, token.name, token.decimals);
          }}
          sx={truncateSelected}
        >
          {tokens.map((t) => (
            <MenuItem key={t.address} value={t.address}>
              {t.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <TextField
        size="small"
        label="Amount"
        type="number"
        inputProps={{ min: 0, step: "any" }}
        value={amountInput}
        onChange={(e) => {
          setAmountInput(e.target.value);
          onAmountChange(fromDisplayAmount(e.target.value, tokenDecimals));
        }}
        // Native number inputs treat wheel events as stepper input — scrolling
        // the page while focused silently decrements the value to 0 and the
        // field renders empty. Blur on wheel so scroll passes through.
        onWheel={(e) => (e.target as HTMLInputElement).blur()}
        sx={{ flexGrow: 1, minWidth: 0 }}
      />
    </Stack>
  );
}
