CREATE TABLE "staff_known_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_token_hash" text NOT NULL,
	"display_label" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_deliveries" ALTER COLUMN "recipient_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ALTER COLUMN "subject" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_login_challenges" ADD COLUMN "device_token_hash" text;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "retention_anchor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "pii_scrubbed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_mail_receipts" ADD COLUMN "message_id_hash" text;--> statement-breakpoint
ALTER TABLE "inbound_mail_receipts" ADD COLUMN "pii_scrubbed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ADD COLUMN "retention_anchor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ADD COLUMN "pii_scrubbed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_known_devices" ADD CONSTRAINT "staff_known_devices_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_known_devices_user_device_idx" ON "staff_known_devices" USING btree ("user_id","device_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_mail_receipts_message_id_hash_idx" ON "inbound_mail_receipts" USING btree ("message_id_hash") WHERE "inbound_mail_receipts"."message_id_hash" IS NOT NULL;