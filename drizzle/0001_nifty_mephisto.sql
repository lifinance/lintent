CREATE TABLE "fill_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"output_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	CONSTRAINT "fill_transactions_output_hash_unique" UNIQUE("output_hash")
);
