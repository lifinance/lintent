import { pgTable, text, bigint } from "drizzle-orm/pg-core";

export const intents = pgTable("intents", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().unique(),
  vm: text("vm").notNull(),
  settler: text("settler").notNull(),
  data: text("data").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const fillTransactions = pgTable("fill_transactions", {
  id: text("id").primaryKey(),
  outputHash: text("output_hash").notNull().unique(),
  txHash: text("tx_hash").notNull(),
});

export const fillRecords = pgTable("fill_records", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  data: text("data").notNull(),
});
