import { type ReactElement } from "react";
import { StatusChip } from "./ui/StatusChip";
import type { OrderContainer } from "../../types/shared";
import { getOrderStatus } from "../../types/shared";

type IntentStatusBadgeProps = {
  order: OrderContainer;
  isClaimed?: boolean;
};

export function IntentStatusBadge({ order, isClaimed }: IntentStatusBadgeProps): ReactElement {
  const status = getOrderStatus(order, isClaimed);
  return <StatusChip status={status} />;
}
