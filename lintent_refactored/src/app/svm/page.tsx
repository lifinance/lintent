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
import { WalletConnectBar } from "../../components/shared/WalletConnectBar.tsx";
import { IntentRow } from "../../components/shared/IntentRow.tsx";
import { useSvmIntent } from "../../hooks/svm/useSvmIntent.ts";
import { useIntents } from "../../hooks/shared/useIntents.ts";
import { useChainSelection } from "../../hooks/shared/useChainSelection.ts";
import { useMultipleWallets } from "../../hooks/shared/useMultipleWallets.ts";
import type { OrderContainer } from "../../types/shared.ts";
import { SvmInputBalanceRow } from "../../components/svm/InputBalanceRow.tsx";

function SvmPageContent(): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const claimedOrderId = searchParams.get("claimed");

  const [recipient, setRecipient] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [svmBalance, setSvmBalance] = useState<bigint | undefined>(undefined);

  const { wallets, multipleWalletsConnected } = useMultipleWallets();
  const evmAddress = wallets.evm.address;
  const publicKey = wallets.svm.address;
  const { isSubmitting, error: intentError, submit: submitIntent } = useSvmIntent();
  const { orders, claimedOrderIds, removeOrder, getStatus } = useIntents();
  const { inputChains, outputChains } = useChainSelection();

  const svmOrders = orders.filter((o) => o.vm === "svm");

  const activeOrders = svmOrders.filter((o) => {
    const s = getStatus(o);
    return s === "active" || s === "expiring";
  });

  const completedOrders = svmOrders.filter((o) => {
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
    router.push(`/svm/${encodeURIComponent(order.orderId)}`);
  };

  const handleSvmBalanceLoaded = useCallback((balance: bigint | undefined): void => {
    setSvmBalance(balance);
  }, []);

  const hasLowBalance = inputChains.some((c) =>
    svmBalance !== undefined && c.amount > 0n && svmBalance < c.amount,
  );

  const effectiveRecipient = recipient.trim().length > 0 ? recipient : (evmAddress ?? "");
  const recipientValid = isAddress(effectiveRecipient, { strict: false });
  const canSubmit = multipleWalletsConnected && inputChains.length > 0 && outputChains.length > 0 && recipientValid;

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={4}>

        {/* Header */}
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h5" fontWeight={700}>Solana Intent</Typography>
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
                onClick={() => router.push(`/svm/${encodeURIComponent(claimedOrder.orderId)}`)}
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
                SOLANA INPUT
              </Typography>
              {inputChains.map((c) => (
                <SvmInputBalanceRow
                  key={c.chainId}
                  tokenName={c.tokenName}
                  tokenDecimals={c.tokenDecimals}
                  mintBytes32={c.tokenAddress as `0x${string}`}
                  amount={c.amount}
                  publicKey={publicKey ?? null}
                  onBalanceLoaded={handleSvmBalanceLoaded}
                />
              ))}
            </Stack>
          </AppCard>
        )}

        {/* Escrow-only notice */}
        <AppCard>
          <Stack spacing={1}>
            <Typography
              variant="caption"
              color="text.secondary"
              fontWeight={600}
              letterSpacing={1}
            >
              SETTLER TYPE
            </Typography>
            <Typography variant="body2">
              Solana intents use <strong>Escrow</strong> only.
              The Compact protocol is EVM-only.
            </Typography>
          </Stack>
        </AppCard>

        {/* Create intent */}
        <AppCard>
          <Stack spacing={2}>
            <Typography variant="subtitle1" fontWeight={600}>Create Intent</Typography>
            <Typography variant="body2" color="text.secondary">
              Approve SPL tokens and open an on-chain Solana escrow position.
            </Typography>
            <TextField
              size="small"
              fullWidth
              label="EVM Recipient (optional)"
              placeholder={`Defaults to ${evmAddress ? `${evmAddress.slice(0, 6)}…${evmAddress.slice(-4)}` : "EVM wallet"}`}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              error={recipient.length > 0 && !isAddress(recipient, { strict: false })}
              helperText={
                recipient.length > 0 && !isAddress(recipient, { strict: false })
                  ? "Enter a valid EVM address (0x...)"
                  : "Leave blank to use the connected EVM wallet."
              }
            />
            <AppButton
              variant="contained"
              color={hasLowBalance ? "error" : "secondary"}
              disabled={!canSubmit || isSubmitting || hasLowBalance}
              fullWidth
              onClick={() => void submitIntent(effectiveRecipient)}
            >
              {hasLowBalance ? "Low Balance" : isSubmitting ? "Submitting..." : "Approve & Open Escrow"}
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
            Open Solana Intents
          </Typography>
          {activeOrders.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No fillable Solana intents. Create one above or import from the intents list.
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

export default function SvmPage(): ReactElement {
  return (
    <Suspense>
      <SvmPageContent />
    </Suspense>
  );
}
