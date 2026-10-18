CREATE TYPE "public"."appointment_reminder_kind" AS ENUM('reminder_7_days', 'reminder_1_day', 'push_1_hour');--> statement-breakpoint
CREATE TYPE "public"."booking_contact_kind" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."conversation_channel" AS ENUM('email', 'whatsapp', 'portal');--> statement-breakpoint
CREATE TYPE "public"."conversation_delivery_state" AS ENUM('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."conversation_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."customer_action_purpose" AS ENUM('pickup_contact_update', 'delivery_contact_update', 'document_view');--> statement-breakpoint
CREATE TYPE "public"."inbound_mail_status" AS ENUM('matched', 'unmatched', 'ignored', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."mail_delivery_kind" AS ENUM('offer', 'order_confirmation', 'handover_protocol', 'return_protocol', 'settlement_damage_missing_notice', 'cancellation_confirmation', 'reminder_7_days', 'reminder_1_day', 'appointment_changed', 'voucher_delivery', 'invoice_delivery', 'manual_customer_reply');--> statement-breakpoint
CREATE TYPE "public"."mail_delivery_status" AS ENUM('pending', 'sending', 'sent', 'retry', 'failed', 'blocked', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."push_delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_event_status" AS ENUM('queued', 'processed', 'ignored', 'failed');--> statement-breakpoint
ALTER TYPE "public"."order_confirmation_status" ADD VALUE 'queued' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."order_confirmation_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TYPE "public"."delivery_packet_status" ADD VALUE 'queued' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."delivery_packet_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TYPE "public"."settlement_customer_notice_status" ADD VALUE 'queued' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."settlement_customer_notice_status" ADD VALUE 'failed';--> statement-breakpoint
CREATE TABLE "appointment_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" "appointment_reminder_kind" NOT NULL,
	"fingerprint" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"mail_delivery_id" uuid,
	"push_delivery_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "booking_contact_kind" NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text NOT NULL,
	"updated_via_token_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_feed_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"regenerated_at" timestamp with time zone,
	"last_access_at" timestamp with time zone,
	CONSTRAINT "calendar_feed_tokens_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "calendar_feed_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid,
	"customer_id" uuid,
	"channel" "conversation_channel" NOT NULL,
	"direction" "conversation_direction" NOT NULL,
	"sender_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"provider_message_id" text,
	"reply_to_provider_message_id" text,
	"mail_delivery_id" uuid,
	"is_system_event" boolean DEFAULT false NOT NULL,
	"delivery_state" "conversation_delivery_state" DEFAULT 'received' NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_by_staff_id" uuid,
	"assigned_by_staff_id" uuid,
	"assigned_at" timestamp with time zone,
	"ignored_at" timestamp with time zone,
	"ignored_by_staff_id" uuid,
	"body_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_action_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "customer_action_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"process_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"booking_id" uuid,
	"appointment_id" uuid,
	"document_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_action_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "customer_action_tokens_document_purpose_check" CHECK (("customer_action_tokens"."purpose" = 'document_view') = ("customer_action_tokens"."document_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "inbound_mail_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox" text NOT NULL,
	"uid_validity" text NOT NULL,
	"uid" integer NOT NULL,
	"message_id" text,
	"fingerprint" text NOT NULL,
	"from_address" text,
	"subject" text,
	"received_at" timestamp with time zone NOT NULL,
	"status" "inbound_mail_status" NOT NULL,
	"match_reason" text,
	"conversation_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_mail_state" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"uid_validity" text,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"last_poll_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "mail_delivery_kind" NOT NULL,
	"process_id" uuid,
	"customer_id" uuid,
	"booking_id" uuid,
	"recipient_email" text NOT NULL,
	"recipient_name" text,
	"subject" text NOT NULL,
	"template_kind" text NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_payload_ciphertext" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "mail_delivery_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"message_id" text NOT NULL,
	"in_reply_to_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sending_since" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_code" text,
	"last_error_code" text,
	"blocked_reason" text,
	"conversation_message_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_deliveries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "mail_deliveries_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "mail_deliveries_attempts_check" CHECK ("mail_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "message_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_photos_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "push_delivery_status" DEFAULT 'pending' NOT NULL,
	"subscriptions_targeted" integer DEFAULT 0 NOT NULL,
	"subscriptions_succeeded" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_deliveries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text
);
--> statement-breakpoint
CREATE TABLE "whatsapp_contacts" (
	"wa_id" text PRIMARY KEY NOT NULL,
	"customer_id" uuid,
	"last_inbound_at" timestamp with time zone,
	"profile_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text NOT NULL,
	"event_type" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"status" "whatsapp_event_status" DEFAULT 'queued' NOT NULL,
	"result_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"conversation_message_id" uuid
);
--> statement-breakpoint
ALTER TABLE "order_confirmations" ADD COLUMN "mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "customer_informed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_packets" ADD COLUMN "mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "cancellations" ADD COLUMN "confirmation_mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "cancellations" ADD COLUMN "invoice_mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "settlement_customer_notices" ADD COLUMN "mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "invoice_mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "lexware_invoice_mappings" ADD COLUMN "mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "mail_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_mail_delivery_id_mail_deliveries_id_fk" FOREIGN KEY ("mail_delivery_id") REFERENCES "public"."mail_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_customer_contacts" ADD CONSTRAINT "booking_customer_contacts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_customer_contacts" ADD CONSTRAINT "booking_customer_contacts_updated_via_token_id_customer_action_tokens_id_fk" FOREIGN KEY ("updated_via_token_id") REFERENCES "public"."customer_action_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_mail_delivery_id_mail_deliveries_id_fk" FOREIGN KEY ("mail_delivery_id") REFERENCES "public"."mail_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_assigned_by_staff_id_staff_users_id_fk" FOREIGN KEY ("assigned_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_ignored_by_staff_id_staff_users_id_fk" FOREIGN KEY ("ignored_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_action_tokens" ADD CONSTRAINT "customer_action_tokens_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_action_tokens" ADD CONSTRAINT "customer_action_tokens_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_action_tokens" ADD CONSTRAINT "customer_action_tokens_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_action_tokens" ADD CONSTRAINT "customer_action_tokens_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_action_tokens" ADD CONSTRAINT "customer_action_tokens_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_mail_receipts" ADD CONSTRAINT "inbound_mail_receipts_conversation_message_id_conversation_messages_id_fk" FOREIGN KEY ("conversation_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ADD CONSTRAINT "mail_deliveries_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ADD CONSTRAINT "mail_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ADD CONSTRAINT "mail_deliveries_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ADD CONSTRAINT "mail_deliveries_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_photos" ADD CONSTRAINT "message_photos_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_staff_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."staff_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_events" ADD CONSTRAINT "whatsapp_events_conversation_message_id_conversation_messages_id_fk" FOREIGN KEY ("conversation_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_reminders_unique_idx" ON "appointment_reminders" USING btree ("appointment_id","kind","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_customer_contacts_booking_kind_idx" ON "booking_customer_contacts" USING btree ("booking_id","kind");--> statement-breakpoint
CREATE INDEX "conversation_messages_process_idx" ON "conversation_messages" USING btree ("process_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_messages_unmatched_idx" ON "conversation_messages" USING btree ("created_at") WHERE "conversation_messages"."process_id" IS NULL AND "conversation_messages"."ignored_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_provider_idx" ON "conversation_messages" USING btree ("channel","provider_message_id") WHERE "conversation_messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_action_tokens_process_idx" ON "customer_action_tokens" USING btree ("process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_mail_receipts_uid_idx" ON "inbound_mail_receipts" USING btree ("mailbox","uid_validity","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_mail_receipts_message_id_idx" ON "inbound_mail_receipts" USING btree ("message_id") WHERE "inbound_mail_receipts"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_mail_receipts_fingerprint_idx" ON "inbound_mail_receipts" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "mail_deliveries_process_idx" ON "mail_deliveries" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "mail_deliveries_status_next_idx" ON "mail_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "message_photos_message_idx" ON "message_photos" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "push_deliveries_user_idx" ON "push_deliveries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_events_provider_idx" ON "whatsapp_events" USING btree ("provider_message_id","event_type");