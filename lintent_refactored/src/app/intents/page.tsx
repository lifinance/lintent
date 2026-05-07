"use client";
import { type ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AddCircleIcon from "@mui/icons-material/AddCircle";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { IntentRow } from "../../components/shared/IntentRow.tsx";
import { useIntents } from "../../hooks/shared/useIntents.ts";
import type { OrderContainer } from "../../types/shared.ts";

export default function IntentsPage(): ReactElement {
  const router = useRouter();
  const { orders, claimedOrderIds, removeOrder, getStatus } = useIntents();
  const [showCompleted, setShowCompleted] = useState(false);

  const sortedOrders = [...orders].sort((a, b) => b.createdAt - a.createdAt);

  const activeOrders = sortedOrders.filter((o) => {
    const s = getStatus(o);
    return s === "active" || s === "expiring";
  });

  const completedOrders = sortedOrders.filter((o) => {
    const s = getStatus(o);
    return s === "expired" || s === "filled" || s === "settled";
  });

  const handleIntentClick = (order: OrderContainer): void => {
    const vm = order.vm === "evm" ? "evm" : "svm";
    router.push(`/${vm}/${encodeURIComponent(order.orderId)}`);
  };

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={4}>

        {/* Header */}
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Stack direction="row" spacing={1} alignItems="center">
            <Button component="a" href="/" startIcon={<ArrowBackIcon />} size="small">
              Back
            </Button>
            <Typography variant="h5" fontWeight={700}>All Intents</Typography>
            {activeOrders.length > 0 && (
              <Chip label={`${activeOrders.length} active`} size="small" color="success" />
            )}
          </Stack>
          <Button
            component="a"
            href="/"
            startIcon={<AddCircleIcon />}
            variant="contained"
            size="small"
          >
            New
          </Button>
        </Stack>

        <Divider />

        {/* Empty state */}
        {sortedOrders.length === 0 && (
          <Stack alignItems="center" spacing={2} sx={{ py: 8 }}>
            <Typography variant="body1" color="text.secondary">
              No intents yet.
            </Typography>
            <Button component="a" href="/" variant="outlined">
              Create your first intent
            </Button>
          </Stack>
        )}

        {/* Active intents -- clickable, navigate to fill page */}
        {activeOrders.length > 0 && (
          <Stack spacing={2}>
            <Typography variant="subtitle1" fontWeight={600}>
              Open Intents
            </Typography>
            {activeOrders.map((order) => (
              <IntentRow
                key={order.orderId}
                order={order}
                onClick={handleIntentClick}
                onDelete={() => removeOrder(order.orderId)}
              />
            ))}
          </Stack>
        )}

        {/* Completed/expired intents -- collapsible */}
        {completedOrders.length > 0 && (
          <Stack spacing={1}>
            <Button
              onClick={() => setShowCompleted((prev) => !prev)}
              endIcon={showCompleted ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              size="small"
              sx={{ alignSelf: "flex-start" }}
            >
              Completed / Expired ({completedOrders.length})
            </Button>
            <Collapse in={showCompleted}>
              <Stack spacing={2}>
                {completedOrders.map((order) => (
                  <IntentRow
                    key={order.orderId}
                    order={order}
                    isClaimed={claimedOrderIds.has(order.orderId)}
                    onClick={handleIntentClick}
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
