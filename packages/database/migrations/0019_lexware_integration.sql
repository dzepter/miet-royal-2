CREATE TYPE "public"."accounting_tax_treatment" AS ENUM('taxable', 'vatfree');--> statement-breakpoint
CREATE TYPE "public"."lexware_connection_status" AS ENUM('not_configured', 'connected', 'error', 'incomplete', 'disconnected', 'organization_mismatch');--> statement-breakpoint
CREATE TYPE "public"."lexware_contact_sync_status" AS ENUM('linked', 'review_required', 'create_unknown');--> statement-breakpoint
CREATE TYPE "public"."lexware_webhook_event_status" AS ENUM('queued', 'processed', 'ignored', 'failed');--> statement-breakpoint
ALTER TYPE "public"."accounting_provider" ADD VALUE 'lexware';--> statement-breakpoint
ALTER TYPE "public"."accounting_transfer_status" ADD VALUE 'in_progress';--> statement-breakpoint
ALTER TYPE "public"."accounting_transfer_status" ADD VALUE 'outcome_unknown';--> statement-breakpoint
ALTER TYPE "public"."accounting_transfer_status" ADD VALUE 'attention';--> statement-breakpoint
CREATE TABLE "accounting_tax_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"treatment" "accounting_tax_treatment" NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"synthetic" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_tax_config_category_unique" UNIQUE("category"),
	CONSTRAINT "accounting_tax_config_rate_check" CHECK ("tax_rate_bp" >= 0 AND "tax_rate_bp" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "lexware_contact_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"lexware_contact_id" text,
	"contact_version" integer,
	"sync_status" "lexware_contact_sync_status" DEFAULT 'linked' NOT NULL,
	"candidates" jsonb,
	"pending_identity" jsonb,
	"linked_at" timestamp with time zone,
	"linked_by" uuid,
	"last_synced_at" timestamp with time zone,
	"last_synced_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lexware_contact_mappings_customer_id_unique" UNIQUE("customer_id"),
	CONSTRAINT "lexware_contact_mappings_linked_check" CHECK (("sync_status" <> 'linked') OR ("lexware_contact_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lexware_integration_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"status" "lexware_connection_status" DEFAULT 'not_configured' NOT NULL,
	"organization_id" text,
	"pending_organization_id" text,
	"connection_id" text,
	"company_name" text,
	"tax_type" text,
	"small_business" boolean,
	"business_features" jsonb,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"webhook_status" text,
	"subscriptions" jsonb,
	"webhooks_checked_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"organization_confirmed_by" uuid,
	"organization_confirmed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lexware_integration_state_environment_unique" UNIQUE("environment")
);
--> statement-breakpoint
CREATE TABLE "lexware_invoice_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_transfer_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"transfer_marker" text NOT NULL,
	"lexware_contact_id" text,
	"lexware_invoice_id" text,
	"voucher_number" text,
	"voucher_status" text,
	"voucher_date" date,
	"due_date" date,
	"expected_gross_cents" integer NOT NULL,
	"open_amount_cents" integer,
	"payment_status" text,
	"paid_date" date,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"attention_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lexware_invoice_mappings_accounting_transfer_id_unique" UNIQUE("accounting_transfer_id"),
	CONSTRAINT "lexware_invoice_mappings_transfer_marker_unique" UNIQUE("transfer_marker"),
	CONSTRAINT "lexware_invoice_mappings_lexware_invoice_id_unique" UNIQUE("lexware_invoice_id"),
	CONSTRAINT "lexware_invoice_mappings_delivery_check" CHECK ("delivery_status" IN ('pending', 'sent'))
);
--> statement-breakpoint
CREATE TABLE "lexware_rate_limit" (
	"id" integer PRIMARY KEY NOT NULL,
	"next_slot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lexware_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"organization_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"event_date" timestamp with time zone NOT NULL,
	"status" "lexware_webhook_event_status" DEFAULT 'queued' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"result_code" text,
	CONSTRAINT "lexware_webhook_events_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD COLUMN "provider_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD COLUMN "provider_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD COLUMN "attention_code" text;--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD COLUMN "attention_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cancellations" ADD COLUMN "invoice_delivery_status" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "invoice_delivery_status" text;--> statement-breakpoint
ALTER TABLE "accounting_tax_config" ADD CONSTRAINT "accounting_tax_config_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lexware_contact_mappings" ADD CONSTRAINT "lexware_contact_mappings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lexware_contact_mappings" ADD CONSTRAINT "lexware_contact_mappings_linked_by_staff_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lexware_integration_state" ADD CONSTRAINT "lexware_integration_state_organization_confirmed_by_staff_users_id_fk" FOREIGN KEY ("organization_confirmed_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lexware_invoice_mappings" ADD CONSTRAINT "lexware_invoice_mappings_accounting_transfer_id_accounting_transfers_id_fk" FOREIGN KEY ("accounting_transfer_id") REFERENCES "public"."accounting_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lexware_contact_mappings_contact_unique" ON "lexware_contact_mappings" USING btree ("organization_id","lexware_contact_id") WHERE "lexware_contact_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lexware_invoice_mappings_status_idx" ON "lexware_invoice_mappings" USING btree ("payment_status","voucher_status");--> statement-breakpoint
CREATE INDEX "lexware_webhook_events_resource_idx" ON "lexware_webhook_events" USING btree ("resource_id","event_type");