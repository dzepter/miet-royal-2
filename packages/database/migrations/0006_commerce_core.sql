CREATE TYPE "public"."billing_mode" AS ENUM('fixed', 'commission', 'included');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('offer', 'order_confirmation', 'delivery_note', 'handover_protocol', 'return_protocol');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_type" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."inquiry_occasion" AS ENUM('birthday', 'wedding', 'company_event', 'club', 'party', 'school_kindergarten', 'festival', 'other');--> statement-breakpoint
CREATE TYPE "public"."line_item_kind" AS ENUM('machine', 'syrup', 'consumable', 'purchase', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('draft', 'sent', 'accepted', 'declined', 'expired', 'recheck_requested');--> statement-breakpoint
CREATE TYPE "public"."order_confirmation_status" AS ENUM('prepared', 'approved', 'sent');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('list', 'special', 'manual', 'included');--> statement-breakpoint
CREATE TYPE "public"."product_category" AS ENUM('machine', 'syrup', 'consumable', 'purchase');--> statement-breakpoint
CREATE TYPE "public"."selection_role" AS ENUM('free', 'extra');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_version_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_snapshot" jsonb NOT NULL,
	"event_snapshot" jsonb NOT NULL,
	"items_snapshot" jsonb NOT NULL,
	"totals_snapshot" jsonb NOT NULL,
	"fulfillment" "fulfillment_type" NOT NULL,
	"delivery_snapshot" jsonb,
	"terms_version_id" uuid,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_process_id_unique" UNIQUE("process_id"),
	CONSTRAINT "bookings_offer_id_unique" UNIQUE("offer_id"),
	CONSTRAINT "bookings_offer_version_id_unique" UNIQUE("offer_version_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "document_type" NOT NULL,
	"process_id" uuid NOT NULL,
	"offer_version_id" uuid,
	"booking_id" uuid,
	"doc_version" integer DEFAULT 1 NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"mime_type" text DEFAULT 'application/pdf' NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"event_date" date,
	"event_start" timestamp with time zone,
	"event_end" timestamp with time zone,
	"guest_count" integer,
	"occasion" "inquiry_occasion",
	"machine_product_id" uuid,
	"fulfillment" "fulfillment_type" DEFAULT 'pickup' NOT NULL,
	"delivery_street" text,
	"delivery_postal_code" text,
	"delivery_city" text,
	"delivery_window_from" timestamp with time zone,
	"delivery_window_to" timestamp with time zone,
	"collection_window_from" timestamp with time zone,
	"collection_window_to" timestamp with time zone,
	"onsite_contact_name" text,
	"onsite_contact_phone" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inquiries_process_id_unique" UNIQUE("process_id")
);
--> statement-breakpoint
CREATE TABLE "inquiry_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"role" "selection_role" NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "offer_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "offer_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"offer_version_id" uuid,
	"order_confirmation_id" uuid,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "line_item_kind" NOT NULL,
	"billing_mode" "billing_mode" NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"standard_unit_price_cents" integer NOT NULL,
	"agreed_unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"price_source" "price_source" NOT NULL,
	"product_id" uuid,
	"product_snapshot" jsonb,
	"special_price_by" uuid,
	"special_price_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offer_version_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_version_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"role" "selection_role" NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "offer_status" DEFAULT 'draft' NOT NULL,
	"machine_product_id" uuid,
	"machine_quantity" integer DEFAULT 1 NOT NULL,
	"fulfillment" "fulfillment_type" DEFAULT 'pickup' NOT NULL,
	"delivery_street" text,
	"delivery_postal_code" text,
	"delivery_city" text,
	"delivery_price_cents" integer,
	"discount_type" "discount_type",
	"discount_value" integer,
	"discount_reason" text,
	"discount_approved_by" uuid,
	"discount_approved_at" timestamp with time zone,
	"machine_subtotal_cents" integer,
	"discount_cents" integer,
	"fixed_total_cents" integer,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"recheck_requested_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"special_prices" jsonb,
	"customer_snapshot" jsonb,
	"event_snapshot" jsonb,
	"terms_version_id" uuid,
	"change_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"current_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_process_id_unique" UNIQUE("process_id")
);
--> statement-breakpoint
CREATE TABLE "order_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"status" "order_confirmation_status" DEFAULT 'prepared' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_confirmations_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"price_cents" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" "product_category" NOT NULL,
	"description" text,
	"sale_unit" text NOT NULL,
	"default_billing_mode" "billing_mode" DEFAULT 'fixed' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"container_count" integer,
	"container_volume_liters" integer,
	"weight_grams" integer,
	"carry_persons" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "terms_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"content" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_versions_label_unique" UNIQUE("label")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_offer_version_id_offer_versions_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "public"."offer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_terms_version_id_terms_versions_id_fk" FOREIGN KEY ("terms_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_offer_version_id_offer_versions_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "public"."offer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_machine_product_id_products_id_fk" FOREIGN KEY ("machine_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_selections" ADD CONSTRAINT "inquiry_selections_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_selections" ADD CONSTRAINT "inquiry_selections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_access_tokens" ADD CONSTRAINT "offer_access_tokens_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_deliveries" ADD CONSTRAINT "offer_deliveries_offer_version_id_offer_versions_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "public"."offer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_deliveries" ADD CONSTRAINT "offer_deliveries_order_confirmation_id_order_confirmations_id_fk" FOREIGN KEY ("order_confirmation_id") REFERENCES "public"."order_confirmations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_items" ADD CONSTRAINT "offer_line_items_offer_version_id_offer_versions_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "public"."offer_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_items" ADD CONSTRAINT "offer_line_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_line_items" ADD CONSTRAINT "offer_line_items_special_price_by_staff_users_id_fk" FOREIGN KEY ("special_price_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_version_selections" ADD CONSTRAINT "offer_version_selections_offer_version_id_offer_versions_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "public"."offer_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_version_selections" ADD CONSTRAINT "offer_version_selections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_machine_product_id_products_id_fk" FOREIGN KEY ("machine_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_discount_approved_by_staff_users_id_fk" FOREIGN KEY ("discount_approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_sent_by_staff_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_confirmations" ADD CONSTRAINT "order_confirmations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_confirmations" ADD CONSTRAINT "order_confirmations_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_process_idx" ON "documents" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "inquiry_selections_inquiry_idx" ON "inquiry_selections" USING btree ("inquiry_id");--> statement-breakpoint
CREATE INDEX "offer_access_tokens_offer_idx" ON "offer_access_tokens" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "offer_line_items_version_idx" ON "offer_line_items" USING btree ("offer_version_id");--> statement-breakpoint
CREATE INDEX "offer_version_selections_version_idx" ON "offer_version_selections" USING btree ("offer_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_versions_offer_version_idx" ON "offer_versions" USING btree ("offer_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "product_prices_product_effective_idx" ON "product_prices" USING btree ("product_id","effective_from");