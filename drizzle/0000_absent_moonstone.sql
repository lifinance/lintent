CREATE TABLE "intents" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"intent_type" text NOT NULL,
	"data" text NOT NULL,
	"created_at" integer NOT NULL
);
