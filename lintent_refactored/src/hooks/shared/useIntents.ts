"use client";

import { useEffect } from "react";
import { useOrdersStore } from "../../store/index";
import type { OrderContainer, OrderStatus } from "../../types/shared";
import { getOrderStatus } from "../../types/shared";

type UseIntentsReturn = {
  orders: OrderContainer[];
  claimedOrderIds: Set<string>;
  addOrder: (order: OrderContainer) => void;
  removeOrder: (orderId: string) => void;
  markOrderClaimed: (orderId: string) => void;
  getStatus: (order: OrderContainer) => OrderStatus;
};

export function useIntents(): UseIntentsReturn {
  const {
    orders,
    claimedOrderIds,
    addOrder,
    removeOrder,
    markOrderClaimed,
    loadFromDb,
  } = useOrdersStore();

  useEffect(() => {
    loadFromDb().catch(console.error);
  }, [loadFromDb]);

  const getStatus = (order: OrderContainer): OrderStatus =>
    getOrderStatus(order, claimedOrderIds.has(order.orderId));

  return { orders, claimedOrderIds, addOrder, removeOrder, markOrderClaimed, getStatus };
}
