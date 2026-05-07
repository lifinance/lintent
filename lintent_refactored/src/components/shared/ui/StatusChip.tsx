import { type ReactElement } from "react";
import Chip from "@mui/material/Chip";
import type { OrderStatus } from "../../../types/shared";

const STATUS_COLORS: Record<OrderStatus, "success" | "warning" | "error" | "info" | "default"> = {
  active: "success",
  expiring: "warning",
  expired: "error",
  filled: "info",
  settled: "default",
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  active: "Active",
  expiring: "Expiring",
  expired: "Expired",
  filled: "Filled",
  settled: "Settled",
};

type StatusChipProps = {
  status: OrderStatus;
};

export function StatusChip({ status }: StatusChipProps): ReactElement {
  return (
    <Chip
      label={STATUS_LABELS[status]}
      color={STATUS_COLORS[status]}
      size="small"
      variant="outlined"
    />
  );
}
