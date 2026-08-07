CREATE TABLE "hyperlane_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"input_chain_id" bigint NOT NULL,
	"output_chain_id" bigint NOT NULL,
	"output_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"submit_tx_hash" text NOT NULL,
	"message_id" text,
	"submitted_at" bigint NOT NULL
);
