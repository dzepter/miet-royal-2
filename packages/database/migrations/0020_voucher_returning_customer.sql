CREATE TYPE "public"."voucher_delivery_status" AS ENUM('pending', 'sent');--> statement-breakpoint
CREATE TYPE "public"."voucher_status" AS ENUM('active', 'reserved', 'redeemed');--> statement-breakpoint
CREATE TYPE "public"."voucher_type" AS ENUM('returning_customer_20');--> statement-breakpoint
ALTER TYPE "public"."settlement_line_source_type" ADD VALUE 'booking_voucher' BEFORE 'delivery_note_item';--> statement-breakpoint
CREATE TABLE "voucher_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone NOT NULL,
	"expires_at_before_redemption" timestamp with time zone NOT NULL,
	"remaining_validity_seconds" integer NOT NULL,
	"cancellation_id" uuid,
	"reactivated_at" timestamp with time zone,
	"final_consumption_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_redemptions_booking_id_unique" UNIQUE("booking_id"),
	CONSTRAINT "voucher_redemptions_remaining_positive_check" CHECK ("voucher_redemptions"."remaining_validity_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_type" "voucher_type" DEFAULT 'returning_customer_20' NOT NULL,
	"customer_id" uuid NOT NULL,
	"origin_process_id" uuid NOT NULL,
	"origin_booking_id" uuid NOT NULL,
	"origin_return_id" uuid NOT NULL,
	"origin_settlement_id" uuid NOT NULL,
	"discount_percent" integer DEFAULT 20 NOT NULL,
	"code_hash" text NOT NULL,
	"code_suffix" text NOT NULL,
	"status" "voucher_status" DEFAULT 'active' NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reserved_offer_id" uuid,
	"reserved_at" timestamp with time zone,
	"delivery_status" "voucher_delivery_status" DEFAULT 'pending' NOT NULL,
	"delivery_problem_code" text,
	"delivered_at" timestamp with time zone,
	"delivery_code_ciphertext" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_origin_settlement_id_unique" UNIQUE("origin_settlement_id"),
	CONSTRAINT "vouchers_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "vouchers_discount_percent_check" CHECK ("vouchers"."discount_percent" = 20),
	CONSTRAINT "vouchers_expires_after_activation_check" CHECK ("vouchers"."expires_at" > "vouchers"."activated_at"),
	CONSTRAINT "vouchers_reservation_consistency_check" CHECK (("vouchers"."status" = 'reserved') = ("vouchers"."reserved_offer_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "voucher_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD COLUMN "voucher_discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD COLUMN "voucher_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_cancellation_id_cancellations_id_fk" FOREIGN KEY ("cancellation_id") REFERENCES "public"."cancellations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_origin_process_id_processes_id_fk" FOREIGN KEY ("origin_process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_origin_booking_id_bookings_id_fk" FOREIGN KEY ("origin_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_origin_return_id_rental_returns_id_fk" FOREIGN KEY ("origin_return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_origin_settlement_id_settlements_id_fk" FOREIGN KEY ("origin_settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_reserved_offer_id_offers_id_fk" FOREIGN KEY ("reserved_offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_redemptions_voucher_idx" ON "voucher_redemptions" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "vouchers_customer_idx" ON "vouchers" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_reserved_offer_idx" ON "vouchers" USING btree ("reserved_offer_id") WHERE "vouchers"."reserved_offer_id" IS NOT NULL;