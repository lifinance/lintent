"use client";
import { type ReactElement } from "react";

import { useState, useCallback, Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import TextField from "@mui/material/TextField";
import Collapse from "@mui/material/Collapse";
import ListIcon from "@mui/icons-material/List";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { isAddress } from "viem";
import { AppCard } from "../../components/shared/ui/AppCard.tsx";
import { AppButton } from "../../components/shared/ui/AppButton.tsx";
import { isSolanaAddress } from "../../lib/config/shared.ts";
import { isSolanaViemChainId } from "../../lib/config/svm.ts";
import { WalletConnectBar } from "../../components/shared/WalletConnectBar.tsx";
import { SettlerSelector } from "../../components/evm/SettlerSelector.tsx";
import { IntentRow } from "../../components/shared/IntentRow.tsx";
import { useEvmIntent } from "../../hooks/evm/useEvmIntent.ts";
import { useIntents } from "../../hooks/shared/useIntents.ts";
import { useChainSelection } from "../../hooks/shared/useChainSelection.ts";
import { useMultipleWallets } from "../../hooks/shared/useMultipleWallets.ts";
import type { SettlerType, OrderContainer } from "../../types/shared.ts";
import { EvmInputBalanceRow } from "../../components/evm/InputBalanceRow.tsx";

function EvmPageContent(): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const claimedOrderId = searchParams.get("claimed");

  const [settler, setSettler] = useState<SettlerType>("escrow");
  const [recipient, setRecipient] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [balances, setBalances] = useState<Record<number, bigint | undefined>>({});

  const { wallets, multipleWalletsConnected } = useMultipleWallets();
  const address = wallets.evm.address;
  const svmPublicKey = wallets.svm.address;
  const { isSubmitting, error: intentError, submit: submitIntent } = useEvmIntent();
  const { orders, claimedOrderIds, removeOrder, getStatus } = useIntents();
  const { inputChains, outputChains } = useChainSelection();

  const handleBalanceLoaded = useCallback((chainId: number, balance: bigint | undefined): void => {
    setBalances((prev) => ({ ...prev, [chainId]: balance }));
  }, []);

  const hasLowBalance = inputChains.some((c) => {
    const bal = balances[c.chainId];
    return bal !== undefined && c.amount > 0n && bal < c.amount;
  });

  const hasSolanaOutput = outputChains.some((c) => isSolanaViemChainId(c.chainId));
  // Default the recipient field from the connected wallets so the user does
  // not need to retype them. The override box is only used when sending to a
  // different wallet than the connected one.
  const defaultRecipient = hasSolanaOutput
    ? (svmPublicKey ?? "")
    : (address ?? "");
  const effectiveRecipient = recipient.trim().length > 0 ? recipient : defaultRecipient;
  const recipientValid = hasSolanaOutput
    ? isSolanaAddress(effectiveRecipient)
    : isAddress(effectiveRecipient, { strict: false });

  const evmOrders = orders.filter((o) => o.vm === "evm");

  const activeOrders = evmOrders.filter((o) => {
    const s = getStatus(o);
    return s === "active" || s === "expiring";
  });

  const completedOrders = evmOrders.filter((o) => {
    const s = getStatus(o);
    return s === "filled" || s === "expired";
  });
  const claimedOrder = claimedOrderId
    ? completedOrders.find((order) => order.orderId === claimedOrderId) ?? null
    : null;

  useEffect(() => {
    if (claimedOrderId) setShowCompleted(true);
  }, [claimedOrderId]);

  const handleOrderClick = (order: OrderContainer): void => {
    router.push(`/evm/${encodeURIComponent(order.orderId)}`);
  };

  const canSubmit = multipleWalletsConnected
    && inputChains.length > 0
    && outputChains.length > 0
    && recipientValid;

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={4}>

        {/* Header */}
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h5" fontWeight={700}>EVM Intent</Typography>
          <Button
            component="a"
            href="/intents"
            startIcon={<ListIcon />}
            size="small"
            variant="outlined"
          >
            All Intents
          </Button>
        </Stack>

        {/* Wallet bar — own row so it never competes with the title for space. */}
        <Stack direction="row" justifyContent="flex-end">
          <WalletConnectBar />
        </Stack>

        {!multipleWalletsConnected && (
          <Alert severity="warning" variant="outlined">
            Connect both an EVM wallet and a Solana wallet to create or fill intents.
          </Alert>
        )}

        {claimedOrder && (
          <Alert
            severity="success"
            variant="filled"
            action={(
              <Button
                color="inherit"
                size="small"
                onClick={() => router.push(`/evm/${encodeURIComponent(claimedOrder.orderId)}`)}
              >
                View
              </Button>
            )}
          >
            Intent claimed successfully. It has been moved to Claimed / Expired below.
          </Alert>
        )}

        {/* Input summary */}
        {inputChains.length > 0 && (
          <AppCard>
            <Stack spacing={1}>
              <Typography variant="subtitle2" color="text.secondary">
                SELECTED INPUTS
              </Typography>
              {inputChains.map((c) => (
                <EvmInputBalanceRow
                  key={c.chainId}
                  chainId={c.chainId}
                  tokenAddress={c.tokenAddress}
                  tokenName={c.tokenName}
                  tokenDecimals={c.tokenDecimals}
                  amount={c.amount}
                  userAddress={address}
                  onBalanceLoaded={handleBalanceLoaded}
                />
              ))}
            </Stack>
          </AppCard>
        )}

        {/* Settler selector */}
        <AppCard>
          <SettlerSelector value={settler} onChange={setSettler} />
        </AppCard>

        {/* Create intent */}
        <AppCard>
          <Stack spacing={2}>
            <Typography variant="subtitle1" fontWeight={600}>Create Intent</Typography>
            <Typography variant="body2" color="text.secondary">
              {settler === "compact"
                ? "Sign a Compact claim and submit to the intent API. No upfront token lock."
                : "Approve tokens and open an on-chain escrow position."}
            </Typography>
            <TextField
              size="small"
              fullWidth
              label={hasSolanaOutput ? "Solana Recipient (optional)" : "Recipient (optional)"}
              placeholder={
                hasSolanaOutput
                  ? `Defaults to ${svmPublicKey ? `${svmPublicKey.slice(0, 6)}…${svmPublicKey.slice(-4)}` : "Solana wallet"}`
                  : `Defaults to ${address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "EVM wallet"}`
              }
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              error={recipient.length > 0 && !recipientValid}
              helperText={
                recipient.length > 0 && !recipientValid
                  ? hasSolanaOutput
                    ? "Enter a valid base58 Solana address"
                    : "Enter a valid EVM address"
                  : "Leave blank to use the connected wallet."
              }
            />
            <AppButton
              variant="contained"
              disabled={!canSubmit || isSubmitting || hasLowBalance}
              fullWidth
              onClick={() => submitIntent(settler, effectiveRecipient || undefined)}
              color={hasLowBalance ? "error" : "primary"}
            >
              {hasLowBalance
                ? "Low Balance"
                : isSubmitting
                  ? "Submitting..."
                  : settler === "compact"
                    ? "Sign & Submit"
                    : "Approve & Open Escrow"}
            </AppButton>
            {intentError && (
              <Typography variant="caption" color="error">
                {intentError}
              </Typography>
            )}
          </Stack>
        </AppCard>

        <Divider />

        {/* Active intents (flat list) */}
        <Stack spacing={2}>
          <Typography variant="h6" fontWeight={600}>
            Open EVM Intents
          </Typography>
          {activeOrders.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No fillable EVM intents. Create one above or import from the intents list.
            </Typography>
          ) : (
            activeOrders.map((order) => (
              <IntentRow
                key={order.orderId}
                order={order}
                onClick={handleOrderClick}
                onDelete={() => removeOrder(order.orderId)}
              />
            ))
          )}
        </Stack>

        {/* Claimed / Expired (collapsible) */}
        {completedOrders.length > 0 && (
          <Stack spacing={1}>
            <Button
              onClick={() => setShowCompleted((prev) => !prev)}
              endIcon={showCompleted ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              size="small"
              sx={{ alignSelf: "flex-start" }}
            >
              Claimed / Expired ({completedOrders.length})
            </Button>
            <Collapse in={showCompleted}>
              <Stack spacing={2}>
                {completedOrders.map((order) => (
                  <IntentRow
                    key={order.orderId}
                    order={order}
                    isClaimed={claimedOrderIds.has(order.orderId)}
                    highlight={order.orderId === claimedOrderId}
                    onClick={handleOrderClick}
                    onDelete={() => removeOrder(order.orderId)}
                  />
                ))}
              </Stack>
            </Collapse>
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

export default function EvmPage(): ReactElement {
  return (
    <Suspense>
      <EvmPageContent />
    </Suspense>
  );
}
