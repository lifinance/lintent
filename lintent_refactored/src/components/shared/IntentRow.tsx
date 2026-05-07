"use client";
import { type ReactElement } from "react";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import DeleteIcon from "@mui/icons-material/Delete";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { AppCard } from "./ui/AppCard.tsx";
import { IntentStatusBadge } from "./IntentStatusBadge.tsx";
import type { OrderContainer, MandateOutput } from "../../types/shared.ts";
import {
  EVM_MAINNET_TOKENS,
  EVM_TESTNET_TOKENS,
  EVM_MAINNET_CHAINS,
  EVM_TESTNET_CHAINS,
} from "../../lib/config/evm.ts";
import { getSvmTokens, isSolanaViemChainId } from "../../lib/config/svm.ts";

type IntentRowProps = {
  order: OrderContainer;
  isClaimed?: boolean;
  highlight?: boolean;
  onClick?: (order: OrderContainer) => void;
  onDelete?: (order: OrderContainer) => void;
};

// --------------- helpers ---------------

const ALL_EVM_CHAINS = [...EVM_MAINNET_CHAINS, ...EVM_TESTNET_CHAINS];
const ALL_EVM_TOKENS = [...EVM_MAINNET_TOKENS, ...EVM_TESTNET_TOKENS];
const ALL_SVM_TOKENS = [...getSvmTokens(false), ...getSvmTokens(true)];

function chainName(chainId: bigint | number): string {
  const id = Number(chainId);
  if (isSolanaViemChainId(id)) return "Solana";
  const chain = ALL_EVM_CHAINS.find((c) => c.id === id);
  return chain?.name ?? `Chain ${id}`;
}

function bigintToHexAddress(val: bigint): `0x${string}` {
  return `0x${val.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function evmTokenName(tokenBigint: bigint, chainId: number): { name: string; decimals: number } {
  const addr = bigintToHexAddress(tokenBigint).toLowerCase();
  const match = ALL_EVM_TOKENS.find(
    (t) => t.address.toLowerCase() === addr && t.chainId === chainId,
  );
  if (match) return { name: match.name, decimals: match.decimals };
  const anyMatch = ALL_EVM_TOKENS.find((t) => t.address.toLowerCase() === addr);
  if (anyMatch) return { name: anyMatch.name, decimals: anyMatch.decimals };
  return { name: addr.slice(0, 6) + "…", decimals: 18 };
}

function outputTokenName(token: `0x${string}`, chainId: bigint): { name: string; decimals: number } {
  const id = Number(chainId);
  if (isSolanaViemChainId(id)) {
    const svmMatch = ALL_SVM_TOKENS.find((t) => t.bytes32Address.toLowerCase() === token.toLowerCase());
    if (svmMatch) return { name: svmMatch.name, decimals: svmMatch.decimals };
  }
  const evmAddr = token.length === 66 ? `0x${token.slice(26)}` : token;
  const match = ALL_EVM_TOKENS.find(
    (t) => t.address.toLowerCase() === evmAddr.toLowerCase() && t.chainId === id,
  );
  if (match) return { name: match.name, decimals: match.decimals };
  const anyMatch = ALL_EVM_TOKENS.find((t) => t.address.toLowerCase() === evmAddr.toLowerCase());
  if (anyMatch) return { name: anyMatch.name, decimals: anyMatch.decimals };
  return { name: evmAddr.slice(0, 6) + "…", decimals: 18 };
}

function formatAmount(amount: bigint, decimals: number): string {
  const num = Number(amount) / 10 ** decimals;
  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  return num.toPrecision(4);
}

type TokenSummary = { chain: string; token: string; amount: string };

function getInputSummary(order: OrderContainer): TokenSummary[] {
  const o = order.order;
  if (o.kind === "standard") {
    const cid = Number(o.originChainId);
    return o.inputs.map(([tokenBig, amountBig]) => {
      const { name, decimals } = evmTokenName(tokenBig, cid);
      return { chain: chainName(o.originChainId), token: name, amount: formatAmount(amountBig, decimals) };
    });
  }
  if (o.kind === "multichain") {
    return o.inputs.flatMap((group) =>
      group.inputs.map(([tokenBig, amountBig]) => {
        const cid = Number(group.chainId);
        const { name, decimals } = evmTokenName(tokenBig, cid);
        return { chain: chainName(group.chainId), token: name, amount: formatAmount(amountBig, decimals) };
      }),
    );
  }
  // svm_standard
  const svmMatch = ALL_SVM_TOKENS.find(
    (t) => t.bytes32Address.toLowerCase() === o.input.tokenBytes32.toLowerCase()
       || t.mintAddress === o.input.token,
  );
  const name = svmMatch?.name ?? o.input.token.slice(0, 6) + "…";
  const decimals = svmMatch?.decimals ?? 9;
  return [{ chain: "Solana", token: name, amount: formatAmount(o.input.amount, decimals) }];
}

function getOutputSummary(order: OrderContainer): TokenSummary[] {
  const seen = new Map<string, TokenSummary>();
  for (const out of order.order.outputs) {
    const key = `${out.chainId}-${out.token}`;
    const { name, decimals } = outputTokenName(out.token, out.chainId);
    const existing = seen.get(key);
    if (existing) {
      const prevRaw = parseFloat(existing.amount);
      const addRaw = Number(out.amount) / 10 ** decimals;
      existing.amount = formatAmount(BigInt(Math.round((prevRaw + addRaw) * 10 ** decimals)), decimals);
    } else {
      seen.set(key, {
        chain: chainName(out.chainId),
        token: name,
        amount: formatAmount(out.amount, decimals),
      });
    }
  }
  return Array.from(seen.values());
}

// --------------- component ---------------

export function IntentRow({ order, isClaimed, highlight = false, onClick, onDelete }: IntentRowProps): ReactElement {
  const isClickable = !!onClick;
  const inputs = getInputSummary(order);
  const outputs = getOutputSummary(order);

  return (
    <AppCard
      onClick={() => onClick?.(order)}
      sx={{
        cursor: isClickable ? "pointer" : "default",
        transition: "border-color 0.15s, background-color 0.15s, box-shadow 0.15s",
        borderColor: highlight ? "success.main" : undefined,
        backgroundColor: highlight ? "rgba(46, 125, 50, 0.06)" : undefined,
        boxShadow: highlight ? "0 0 0 1px rgba(46, 125, 50, 0.18)" : undefined,
        "&:hover": isClickable
          ? {
              borderColor: highlight ? "success.main" : "primary.main",
            }
          : {},
      }}
    >
      <Stack spacing={1}>
        {/* Top row: chips + status */}
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              label={order.vm.toUpperCase()}
              size="small"
              color={order.vm === "evm" ? "primary" : "secondary"}
            />
            <Chip label={order.settler} size="small" variant="outlined" />
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <IntentStatusBadge order={order} isClaimed={isClaimed} />
            {onDelete && (
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(order);
                }}
                sx={{ ml: 0.5 }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            )}
          </Stack>
        </Stack>

        {/* Input -> Output summary */}
        <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap" }}>
          <Stack spacing={0}>
            {inputs.map((inp, i) => (
              <Typography key={i} variant="body2" fontWeight={600}>
                {inp.amount} {inp.token}
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  on {inp.chain}
                </Typography>
              </Typography>
            ))}
          </Stack>

          <ArrowForwardIcon fontSize="small" color="action" />

          <Stack spacing={0}>
            {outputs.map((out, i) => (
              <Typography key={i} variant="body2" fontWeight={600}>
                {out.amount} {out.token}
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  on {out.chain}
                </Typography>
              </Typography>
            ))}
          </Stack>
        </Stack>

        {/* Order ID + expiry */}
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="caption" color="text.disabled" noWrap>
            {order.orderId.slice(0, 10)}…{order.orderId.slice(-6)}
          </Typography>
          <Typography variant="caption" color="text.disabled">
            Expires {new Date(order.order.expires * 1000).toLocaleString()}
          </Typography>
        </Stack>
      </Stack>
    </AppCard>
  );
}
