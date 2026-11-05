CREATE TYPE "public"."customer_portal_magic_link_purpose" AS ENUM('login', 'reauth', 'email_change');--> statement-breakpoint
ALTER TYPE "public"."mail_delivery_kind" ADD VALUE 'customer_portal_magic_link';--> statement-breakpoint
ALTER TYPE "public"."mail_delivery_kind" ADD VALUE 'customer_portal_reply_notice';--> statement-breakpoint
ALTER TYPE "public"."mail_delivery_kind" ADD VALUE 'customer_portal_reauth';--> statement-breakpoint
ALTER TYPE "public"."mail_delivery_kind" ADD VALUE 'customer_portal_email_change';--> statement-breakpoint
CREATE TABLE "customer_portal_magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"purpose" "customer_portal_magic_link_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" uuid,
	"proposed_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "customer_portal_magic_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "customer_portal_magic_links_purpose_check" CHECK (("customer_portal_magic_links"."purpose" = 'login' AND "customer_portal_magic_links"."session_id" IS NULL AND "customer_portal_magic_links"."proposed_email" IS NULL) OR ("customer_portal_magic_links"."purpose" = 'reauth' AND "customer_portal_magic_links"."session_id" IS NOT NULL AND "customer_portal_magic_links"."proposed_email" IS NULL) OR ("customer_portal_magic_links"."purpose" = 'email_change' AND "customer_portal_magic_links"."session_id" IS NOT NULL AND "customer_portal_magic_links"."proposed_email" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "customer_portal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"reauthenticated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent_label" text,
	CONSTRAINT "customer_portal_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "customer_portal_sessions_expiry_check" CHECK ("customer_portal_sessions"."expires_at" > "customer_portal_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "customer_portal_magic_links" ADD CONSTRAINT "customer_portal_magic_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_portal_magic_links" ADD CONSTRAINT "customer_portal_magic_links_session_id_customer_portal_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."customer_portal_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_portal_sessions" ADD CONSTRAINT "customer_portal_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_portal_magic_links_customer_idx" ON "customer_portal_magic_links" USING btree ("customer_id","purpose");--> statement-breakpoint
CREATE INDEX "customer_portal_magic_links_expires_idx" ON "customer_portal_magic_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "customer_portal_sessions_customer_idx" ON "customer_portal_sessions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_portal_sessions_expires_idx" ON "customer_portal_sessions" USING btree ("expires_at");