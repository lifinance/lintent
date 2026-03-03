CREATE TABLE "transaction_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"receipt" text NOT NULL,
	"created_at" bigint NOT NULL
);
