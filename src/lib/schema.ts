import { pgTable, text, bigint, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const intents = pgTable("intents", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().unique(),
  intentType: text("intent_type").notNull(),
  data: text("data").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull()
});

export const fillTransactions = pgTable("fill_transactions", {
  id: text("id").primaryKey(),
  outputHash: text("output_hash").notNull().unique(),
  txHash: text("tx_hash").notNull()
});

export const transactionReceipts = pgTable("transaction_receipts", {
  id: text("id").primaryKey(),
  chainId: bigint("chain_id", { mode: "number" }).notNull(),
  txHash: text("tx_hash").notNull(),
  receipt: text("receipt").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull()
});

/**
 * Evidence that a Hyperlane `submit` was dispatched for one (order, input chain,
 * output) triple. Persisted because a second submit pays interchain gas again, and
 * because "filled" and "relaying" are different states the UI must not conflate.
 */
export const hyperlaneSubmissions = pgTable("hyperlane_submissions", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  inputChainId: bigint("input_chain_id", { mode: "number" }).notNull(),
  outputChainId: bigint("output_chain_id", { mode: "number" }).notNull(),
  outputHash: text("output_hash").notNull(),
  payloadHash: text("payload_hash").notNull(),
  submitTxHash: text("submit_tx_hash").notNull(),
  messageId: text("message_id"),
  submittedAt: bigint("submitted_at", { mode: "number" }).notNull()
});

export const tokens = pgTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    name: text("name").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    decimals: bigint("decimals", { mode: "number" }).notNull(),
    isManual: boolean("is_manual").notNull().default(false),
    isTestnet: boolean("is_testnet").notNull().default(false)
  },
  (table) => [uniqueIndex("tokens_address_chain_idx").on(table.address, table.chainId)]
);

export const schema = {
  intents,
  fillTransactions,
  transactionReceipts,
  hyperlaneSubmissions,
  tokens
};
