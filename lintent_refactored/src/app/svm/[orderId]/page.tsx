"use client";
import { type ReactElement } from "react";

import { use } from "react";
import { useRouter } from "next/navigation";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { IntentRow } from "../../../components/shared/IntentRow.tsx";
import { WalletConnectBar } from "../../../components/shared/WalletConnectBar.tsx";
import { SvmFillActions } from "../../../components/svm/SvmFillActions.tsx";
import { useMultipleWallets } from "../../../hooks/shared/useMultipleWallets.ts";
import { useIntents } from "../../../hooks/shared/useIntents.ts";

type Params = { orderId: string };

export default function SvmOrderPage({
  params,
}: {
  params: Promise<Params>;
}): ReactElement {
  const { orderId } = use(params);
  const router = useRouter();
  const { wallets, multipleWalletsConnected } = useMultipleWallets();
  const publicKey = wallets.svm.address;
  const { orders, claimedOrderIds, getStatus } = useIntents();

  const decodedId = decodeURIComponent(orderId);
  const order = orders.find((o) => o.orderId === decodedId) ?? null;

  const handleClaimed = (): void => {
    router.push(`/svm?claimed=${encodeURIComponent(decodedId)}`);
  };

  if (!order) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Stack spacing={3}>
          <Button href="/svm" startIcon={<ArrowBackIcon />} size="small">
            Back to Solana
          </Button>
          <Alert severity="warning">
            Intent not found. It may have been deleted or not yet loaded.
          </Alert>
        </Stack>
      </Container>
    );
  }

  const status = getStatus(order);

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={4}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Button href="/svm" startIcon={<ArrowBackIcon />} size="small">
            Back to Solana
          </Button>
        </Stack>

        <Stack direction="row" justifyContent="flex-end">
          <WalletConnectBar />
        </Stack>

        <Typography variant="h5" fontWeight={700}>
          Solana Intent Detail
        </Typography>

        {!multipleWalletsConnected && (
          <Alert severity="warning" variant="outlined">
            Connect both an EVM wallet and a Solana wallet to fill or claim this intent.
          </Alert>
        )}

        <IntentRow
          order={order}
          isClaimed={claimedOrderIds.has(order.orderId)}
        />

        {status === "filled" ? (
          <Alert severity="success">This intent has been claimed.</Alert>
        ) : status === "expired" ? (
          <Alert severity="error">This intent has expired.</Alert>
        ) : multipleWalletsConnected ? (
          <SvmFillActions
            order={order}
            fillerPublicKey={publicKey}
            onClaimed={handleClaimed}
          />
        ) : null}
      </Stack>
    </Container>
  );
}
