DROP TABLE IF EXISTS "transaction_receipts";
--> statement-breakpoint
DROP TABLE IF EXISTS "tokens";
--> statement-breakpoint
DROP TABLE IF EXISTS "intents";
--> statement-breakpoint
DROP TABLE IF EXISTS "fill_transactions";
--> statement-breakpoint
CREATE TABLE "fill_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"output_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	CONSTRAINT "fill_transactions_output_hash_unique" UNIQUE("output_hash")
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"intent_type" text NOT NULL,
	"data" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "intents_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"name" text NOT NULL,
	"chain_id" bigint NOT NULL,
	"decimals" bigint NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"is_testnet" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"receipt" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_address_chain_idx" ON "tokens" USING btree ("address","chain_id");
