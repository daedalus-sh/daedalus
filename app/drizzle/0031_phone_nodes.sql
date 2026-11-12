CREATE TABLE "node_pair_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"address" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"spent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_pair_tickets_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "node_tokens" (
	"node_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "node_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "device" jsonb;--> statement-breakpoint
ALTER TABLE "node_tokens" ADD CONSTRAINT "node_tokens_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;