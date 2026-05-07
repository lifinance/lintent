import { eq } from "drizzle-orm";
import { getDb } from "./index";
import { intents, fillTransactions, fillRecords } from "./schema";
import type { OrderContainer, SolanaFillRecord } from "../../types/shared";

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { __bigint: value.toString() };
  return value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__bigint" in value) {
    return BigInt((value as { __bigint: string }).__bigint);
  }
  return value;
}

// --------------- Intents ---------------

export type OrderRow = {
  order: OrderContainer;
  status: string;
};

export async function loadOrders(): Promise<OrderRow[]> {
  const db = await getDb();
  const rows = await db.select().from(intents);
  return rows.map((r) => ({
    order: JSON.parse(r.data, bigintReviver) as OrderContainer,
    status: r.status,
  }));
}

export async function saveOrder(order: OrderContainer): Promise<void> {
  const db = await getDb();
  const serialised = JSON.stringify(order, bigintReplacer);
  await db
    .insert(intents)
    .values({
      id: order.orderId,
      orderId: order.orderId,
      vm: order.vm,
      settler: order.settler,
      data: serialised,
      status: "active",
      createdAt: order.createdAt,
    })
    .onConflictDoUpdate({
      target: intents.orderId,
      set: { data: serialised },
    });
}

export async function deleteOrder(orderId: string): Promise<void> {
  const db = await getDb();
  await db.delete(intents).where(eq(intents.orderId, orderId));
}

export async function markOrderClaimed(orderId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(intents)
    .set({ status: "claimed" })
    .where(eq(intents.orderId, orderId));
}

// --------------- Fill Transactions ---------------

export async function loadFillTransactions(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.select().from(fillTransactions);
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.outputHash] = r.txHash;
  }
  return map;
}

export async function saveFillTransaction(
  outputHash: string,
  txHash: string,
): Promise<void> {
  const db = await getDb();
  await db
    .insert(fillTransactions)
    .values({
      id: outputHash,
      outputHash,
      txHash,
    })
    .onConflictDoUpdate({
      target: fillTransactions.outputHash,
      set: { txHash },
    });
}

// --------------- Fill Records (Solana) ---------------

export async function loadFillRecords(): Promise<
  Record<string, SolanaFillRecord>
> {
  const db = await getDb();
  const rows = await db.select().from(fillRecords);
  const map: Record<string, SolanaFillRecord> = {};
  for (const r of rows) {
    map[r.key] = JSON.parse(r.data, bigintReviver) as SolanaFillRecord;
  }
  return map;
}

export async function saveFillRecord(
  key: string,
  record: SolanaFillRecord,
): Promise<void> {
  const db = await getDb();
  const serialised = JSON.stringify(record, bigintReplacer);
  await db
    .insert(fillRecords)
    .values({ id: key, key, data: serialised })
    .onConflictDoUpdate({
      target: fillRecords.key,
      set: { data: serialised },
    });
}
