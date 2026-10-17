CREATE TYPE "public"."accounting_payment_status" AS ENUM('open', 'paid', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."accounting_provider" AS ENUM('mock', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."accounting_transfer_kind" AS ENUM('settlement', 'cancellation');--> statement-breakpoint
CREATE TYPE "public"."accounting_transfer_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."advance_payment_status" AS ENUM('active', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."cancellation_canceler_type" AS ENUM('employee', 'admin', 'customer');--> statement-breakpoint
CREATE TYPE "public"."cancellation_finance_status" AS ENUM('no_invoice', 'accounting_pending', 'invoice_open', 'paid');--> statement-breakpoint
CREATE TYPE "public"."settlement_customer_notice_status" AS ENUM('prepared', 'approved', 'sent', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."process_relation_kind" AS ENUM('cancellation_follow_up');--> statement-breakpoint
CREATE TYPE "public"."security_deposit_status" AS ENUM('held', 'released', 'applied');--> statement-breakpoint
CREATE TYPE "public"."settlement_clarification_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."settlement_clarification_type" AS ENUM('damage_cost', 'missing_item_cost', 'customer_notice', 'customer_response');--> statement-breakpoint
CREATE TYPE "public"."settlement_line_source_type" AS ENUM('booking_item', 'booking_delivery', 'booking_discount', 'delivery_note_item', 'return_inventory_item', 'return_machine', 'machine_damage', 'missing_accessory_case', 'manual', 'advance_payment', 'security_deposit');--> statement-breakpoint
CREATE TYPE "public"."settlement_line_type" AS ENUM('machine_rental', 'delivery', 'purchase', 'commission_consumption', 'discount', 'cleanup_fee', 'damage_charge', 'missing_item_charge', 'late_fee', 'manual_charge', 'advance_payment_credit', 'deposit_applied_credit');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('preparing', 'clarification_required', 'customer_notice_required', 'customer_waiting', 'ready_for_accounting', 'transferring', 'transferred', 'transfer_failed');--> statement-breakpoint
CREATE TABLE "accounting_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "accounting_transfer_kind" NOT NULL,
	"settlement_id" uuid,
	"cancellation_id" uuid,
	"process_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "accounting_transfer_status" DEFAULT 'pending' NOT NULL,
	"provider" "accounting_provider" NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"external_reference" text,
	"payment_status" "accounting_payment_status",
	"transferred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_transfers_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "accounting_transfers_target_check" CHECK (("kind" = 'settlement' AND "settlement_id" IS NOT NULL AND "cancellation_id" IS NULL) OR ("kind" = 'cancellation' AND "cancellation_id" IS NOT NULL AND "settlement_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "booking_advance_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"received_at" date NOT NULL,
	"external_reference" text,
	"status" "advance_payment_status" DEFAULT 'active' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_advance_payments_amount_check" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "booking_security_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"applied_cents" integer DEFAULT 0 NOT NULL,
	"received_at" date NOT NULL,
	"external_reference" text,
	"status" "security_deposit_status" DEFAULT 'held' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_security_deposits_amount_check" CHECK ("amount_cents" > 0),
	CONSTRAINT "booking_security_deposits_applied_check" CHECK ("applied_cents" >= 0 AND "applied_cents" <= "amount_cents")
);
--> statement-breakpoint
CREATE TABLE "cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"canceler_type" "cancellation_canceler_type" NOT NULL,
	"canceler_staff_id" uuid,
	"cancelled_at" timestamp with time zone NOT NULL,
	"event_date" date NOT NULL,
	"remaining_days" integer NOT NULL,
	"fee_percent" integer NOT NULL,
	"base_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"rounding_method" text DEFAULT 'half_up' NOT NULL,
	"finance_status" "cancellation_finance_status" DEFAULT 'no_invoice' NOT NULL,
	"accounting_transfer_id" uuid,
	"accounting_provider" "accounting_provider",
	"accounting_reference" text,
	"payment_status" "accounting_payment_status",
	"transferred_at" timestamp with time zone,
	"last_transfer_error_code" text,
	"released_resources" jsonb,
	"confirmation_status" text DEFAULT 'prepared' NOT NULL,
	"confirmation_sent_at" timestamp with time zone,
	"confirmation_gateway_reference" text,
	"external_refund_review_required" boolean DEFAULT false NOT NULL,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellations_process_id_unique" UNIQUE("process_id"),
	CONSTRAINT "cancellations_booking_id_unique" UNIQUE("booking_id"),
	CONSTRAINT "cancellations_fee_percent_check" CHECK ("fee_percent" IN (0, 50, 100)),
	CONSTRAINT "cancellations_fee_check" CHECK ("fee_cents" >= 0 AND "base_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "process_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"previous_process_id" uuid NOT NULL,
	"follow_up_process_id" uuid NOT NULL,
	"kind" "process_relation_kind" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_relations_follow_up_process_id_unique" UNIQUE("follow_up_process_id"),
	CONSTRAINT "process_relations_distinct_check" CHECK ("previous_process_id" <> "follow_up_process_id")
);
--> statement-breakpoint
CREATE TABLE "settlement_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"type" "settlement_clarification_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "settlement_clarification_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_customer_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"status" "settlement_customer_notice_status" DEFAULT 'prepared' NOT NULL,
	"recipient_email" text,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"positions_snapshot" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"gateway" text,
	"gateway_reference" text,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_customer_notices_settlement_id_unique" UNIQUE("settlement_id")
);
--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"type" "settlement_line_type" NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit" text DEFAULT 'Stück' NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"source_type" "settlement_line_source_type" NOT NULL,
	"source_key" text NOT NULL,
	"source_id" uuid,
	"source_snapshot" jsonb,
	"internal_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_lines_amount_check" CHECK ("amount_cents" >= 0),
	CONSTRAINT "settlement_lines_quantity_check" CHECK ("quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"status" "settlement_status" DEFAULT 'preparing' NOT NULL,
	"fixed_total_cents" integer DEFAULT 0 NOT NULL,
	"variable_total_cents" integer DEFAULT 0 NOT NULL,
	"charges_total_cents" integer DEFAULT 0 NOT NULL,
	"credits_total_cents" integer DEFAULT 0 NOT NULL,
	"amount_due_cents" integer DEFAULT 0 NOT NULL,
	"overpayment_cents" integer DEFAULT 0 NOT NULL,
	"notice_required" boolean DEFAULT false NOT NULL,
	"notice_sent_at" timestamp with time zone,
	"wait_until" timestamp with time zone,
	"customer_response_received_at" timestamp with time zone,
	"amounts_changed_after_notice_at" timestamp with time zone,
	"manual_transfer_required" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"early_released_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"transferred_at" timestamp with time zone,
	"accounting_transfer_id" uuid,
	"accounting_provider" "accounting_provider",
	"accounting_reference" text,
	"payment_status" "accounting_payment_status",
	"last_transfer_error_code" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_process_id_unique" UNIQUE("process_id"),
	CONSTRAINT "settlements_booking_id_unique" UNIQUE("booking_id"),
	CONSTRAINT "settlements_return_id_unique" UNIQUE("return_id"),
	CONSTRAINT "settlements_amount_due_check" CHECK ("amount_due_cents" >= 0),
	CONSTRAINT "settlements_overpayment_check" CHECK ("overpayment_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD CONSTRAINT "accounting_transfers_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_transfers" ADD CONSTRAINT "accounting_transfers_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_advance_payments" ADD CONSTRAINT "booking_advance_payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_advance_payments" ADD CONSTRAINT "booking_advance_payments_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_advance_payments" ADD CONSTRAINT "booking_advance_payments_recorded_by_staff_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_advance_payments" ADD CONSTRAINT "booking_advance_payments_cancelled_by_staff_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_security_deposits" ADD CONSTRAINT "booking_security_deposits_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_security_deposits" ADD CONSTRAINT "booking_security_deposits_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_security_deposits" ADD CONSTRAINT "booking_security_deposits_recorded_by_staff_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_security_deposits" ADD CONSTRAINT "booking_security_deposits_released_by_staff_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_canceler_staff_id_staff_users_id_fk" FOREIGN KEY ("canceler_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_reopened_by_staff_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_relations" ADD CONSTRAINT "process_relations_previous_process_id_processes_id_fk" FOREIGN KEY ("previous_process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_relations" ADD CONSTRAINT "process_relations_follow_up_process_id_processes_id_fk" FOREIGN KEY ("follow_up_process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_relations" ADD CONSTRAINT "process_relations_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_clarifications" ADD CONSTRAINT "settlement_clarifications_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_clarifications" ADD CONSTRAINT "settlement_clarifications_resolved_by_staff_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_customer_notices" ADD CONSTRAINT "settlement_customer_notices_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_customer_notices" ADD CONSTRAINT "settlement_customer_notices_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_released_by_staff_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_transfers_settlement_unique" ON "accounting_transfers" USING btree ("settlement_id") WHERE "settlement_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_transfers_cancellation_unique" ON "accounting_transfers" USING btree ("cancellation_id") WHERE "cancellation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "booking_advance_payments_booking_idx" ON "booking_advance_payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_security_deposits_booking_idx" ON "booking_security_deposits" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "process_relations_previous_idx" ON "process_relations" USING btree ("previous_process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_clarifications_unique" ON "settlement_clarifications" USING btree ("settlement_id","type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_lines_source_unique" ON "settlement_lines" USING btree ("settlement_id","source_type","source_key");--> statement-breakpoint
CREATE INDEX "settlement_lines_settlement_idx" ON "settlement_lines" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "settlements_status_idx" ON "settlements" USING btree ("status","wait_until");