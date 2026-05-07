import { create } from "zustand";
import type {
  OrderContainer,
  SolanaFillRecord,
} from "../types/shared";
import {
  loadOrders,
  saveOrder,
  deleteOrder,
  loadFillTransactions,
  saveFillTransaction,
  loadFillRecords,
  saveFillRecord,
  markOrderClaimed as markOrderClaimedDb,
} from "../lib/db/queries";

type OrdersState = {
  orders: OrderContainer[];
  claimedOrderIds: Set<string>;
  fillTransactions: Record<string, string>;
  fillRecords: Record<string, SolanaFillRecord>;
  addOrder: (order: OrderContainer) => void;
  removeOrder: (orderId: string) => void;
  markOrderClaimed: (orderId: string) => void;
  setFillTransaction: (outputHash: string, txHash: string) => void;
  setFillRecord: (key: string, record: SolanaFillRecord) => void;
  getFillRecord: (key: string) => SolanaFillRecord | undefined;
  loadFromDb: () => Promise<void>;
};

export const useOrdersStore = create<OrdersState>((set, get) => ({
  orders: [],
  claimedOrderIds: new Set<string>(),
  fillTransactions: {},
  fillRecords: {},

  addOrder: (order) => {
    const orders = [...get().orders, order];
    set({ orders });
    saveOrder(order).catch(console.error);
  },

  removeOrder: (orderId) => {
    const orders = get().orders.filter((o) => o.orderId !== orderId);
    const claimed = new Set(get().claimedOrderIds);
    claimed.delete(orderId);
    set({ orders, claimedOrderIds: claimed });
    deleteOrder(orderId).catch(console.error);
  },

  markOrderClaimed: (orderId) => {
    const claimed = new Set(get().claimedOrderIds);
    claimed.add(orderId);
    set({ claimedOrderIds: claimed });
    markOrderClaimedDb(orderId).catch(console.error);
  },

  setFillTransaction: (outputHash, txHash) => {
    const fillTransactions = {
      ...get().fillTransactions,
      [outputHash]: txHash,
    };
    set({ fillTransactions });
    saveFillTransaction(outputHash, txHash).catch(console.error);
  },

  setFillRecord: (key, record) => {
    const fillRecords = { ...get().fillRecords, [key]: record };
    set({ fillRecords });
    saveFillRecord(key, record).catch(console.error);
  },

  getFillRecord: (key) => get().fillRecords[key],

  loadFromDb: async () => {
    if (typeof window === "undefined") return;
    const [rows, fillTxs, fillRecs] = await Promise.all([
      loadOrders(),
      loadFillTransactions(),
      loadFillRecords(),
    ]);
    const orders = rows.map((r) => r.order);
    const claimed = new Set<string>();
    for (const r of rows) {
      if (r.status === "claimed") claimed.add(r.order.orderId);
    }
    set({
      orders,
      claimedOrderIds: claimed,
      fillTransactions: fillTxs,
      fillRecords: fillRecs,
    });
  },
}));
