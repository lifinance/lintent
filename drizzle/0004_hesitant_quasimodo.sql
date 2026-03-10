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
ALTER TABLE "intents" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_address_chain_idx" ON "tokens" USING btree ("address","chain_id");--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_order_id_unique" UNIQUE("order_id");