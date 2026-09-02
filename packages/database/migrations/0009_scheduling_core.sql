CREATE TYPE "public"."appointment_kind" AS ENUM('pickup', 'return', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."appointment_location_kind" AS ENUM('base', 'customer');--> statement-breakpoint
CREATE TYPE "public"."appointment_source" AS ENUM('booking', 'manual');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "appointment_conflict_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_overdue_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"missed_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"admin_notified_at" timestamp with time zone,
	"customer_contacted_at" timestamp with time zone,
	"customer_contacted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "appointment_kind" NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"location_kind" "appointment_location_kind" NOT NULL,
	"location_snapshot" jsonb,
	"assigned_user_id" uuid,
	"source" "appointment_source" DEFAULT 'booking' NOT NULL,
	"customer_info_required_at" timestamp with time zone,
	"acknowledgement_requested_at" timestamp with time zone,
	"acknowledgement_requested_for" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"assignment_notified_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_window_check" CHECK ("end_at" IS NULL OR "start_at" IS NOT NULL),
	CONSTRAINT "appointments_window_order_check" CHECK ("end_at" IS NULL OR "start_at" IS NULL OR "end_at" > "start_at")
);
--> statement-breakpoint
CREATE TABLE "staff_substitutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_user_id" uuid NOT NULL,
	"substitute_user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_early_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_substitutions_distinct_check" CHECK ("original_user_id" <> "substitute_user_id"),
	CONSTRAINT "staff_substitutions_range_check" CHECK ("ends_at" > "starts_at")
);
--> statement-breakpoint
ALTER TABLE "appointment_overdue_incidents" ADD CONSTRAINT "appointment_overdue_incidents_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_overdue_incidents" ADD CONSTRAINT "appointment_overdue_incidents_customer_contacted_by_staff_users_id_fk" FOREIGN KEY ("customer_contacted_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_assigned_user_id_staff_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_acknowledgement_requested_for_staff_users_id_fk" FOREIGN KEY ("acknowledgement_requested_for") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_acknowledged_by_staff_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_completed_by_staff_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_substitutions" ADD CONSTRAINT "staff_substitutions_original_user_id_staff_users_id_fk" FOREIGN KEY ("original_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_substitutions" ADD CONSTRAINT "staff_substitutions_substitute_user_id_staff_users_id_fk" FOREIGN KEY ("substitute_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_substitutions" ADD CONSTRAINT "staff_substitutions_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_suppressions_fingerprint_unique" ON "appointment_conflict_suppressions" USING btree ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "overdue_incidents_open_appointment_missed_unique" ON "appointment_overdue_incidents" USING btree ("appointment_id","missed_at") WHERE "resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "overdue_incidents_open_idx" ON "appointment_overdue_incidents" USING btree ("resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_booking_kind_unique" ON "appointments" USING btree ("booking_id","kind");--> statement-breakpoint
CREATE INDEX "appointments_process_idx" ON "appointments" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "appointments_start_idx" ON "appointments" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "appointments_assigned_idx" ON "appointments" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "appointments_status_idx" ON "appointments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "staff_substitutions_original_idx" ON "staff_substitutions" USING btree ("original_user_id","starts_at");