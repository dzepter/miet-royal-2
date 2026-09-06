CREATE TYPE "public"."delivery_note_item_kind" AS ENUM('included', 'commission', 'purchase');--> statement-breakpoint
CREATE TYPE "public"."delivery_note_status" AS ENUM('draft', 'final');--> statement-breakpoint
CREATE TYPE "public"."delivery_packet_status" AS ENUM('ready', 'sent');--> statement-breakpoint
CREATE TYPE "public"."handover_recipient_kind" AS ENUM('customer', 'representative', 'other');--> statement-breakpoint
CREATE TYPE "public"."handover_signature_role" AS ENUM('customer', 'staff');--> statement-breakpoint
CREATE TYPE "public"."handover_status" AS ENUM('draft', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."machine_assignment_status" AS ENUM('open', 'assigned', 'prepared', 'issued', 'returned');--> statement-breakpoint
CREATE TYPE "public"."machine_risk_incident_reason" AS ENUM('status', 'block');--> statement-breakpoint
CREATE TABLE "booking_additions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"billing_mode" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_additions_quantity_check" CHECK ("quantity" >= 1),
	CONSTRAINT "booking_additions_price_check" CHECK ("unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "booking_pickup_representatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text,
	"phone_deleted_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_pickup_representatives_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_note_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_note_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "delivery_note_item_kind" NOT NULL,
	"product_id" uuid,
	"inventory_item_id" uuid,
	"booking_addition_id" uuid,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"planned_quantity" integer NOT NULL,
	"actual_quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"billing_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_note_items_planned_check" CHECK ("planned_quantity" >= 0),
	CONSTRAINT "delivery_note_items_actual_check" CHECK ("actual_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"status" "delivery_note_status" DEFAULT 'draft' NOT NULL,
	"document_id" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_notes_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"process_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"handover_id" uuid,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"document_ids" jsonb NOT NULL,
	"status" "delivery_packet_status" DEFAULT 'ready' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handover_machine_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handover_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"checked_by" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handover_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handover_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"taken_by" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handover_photos_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "handover_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handover_id" uuid NOT NULL,
	"role" "handover_signature_role" NOT NULL,
	"signer_name" text NOT NULL,
	"signer_user_id" uuid,
	"storage_key" text NOT NULL,
	"mime_type" text DEFAULT 'image/png' NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handover_signatures_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"status" "handover_status" DEFAULT 'draft' NOT NULL,
	"recipient_kind" "handover_recipient_kind",
	"recipient_name" text,
	"recipient_phone" text,
	"appointment_id" uuid,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"actual_issue_at" timestamp with time zone,
	"actual_issue_corrected_by" uuid,
	"actual_issue_corrected_at" timestamp with time zone,
	"protocol_document_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handovers_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
CREATE TABLE "machine_assignment_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"problem_codes" jsonb NOT NULL,
	"problem_summary" text NOT NULL,
	"situation_fingerprint" text NOT NULL,
	"reason" text NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "machine_assignment_overrides_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "machine_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"slot_no" integer NOT NULL,
	"machine_id" uuid,
	"status" "machine_assignment_status" DEFAULT 'open' NOT NULL,
	"rental_from" timestamp with time zone,
	"rental_to" timestamp with time zone,
	"created_by" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone,
	"prepared_by" uuid,
	"prepared_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"returned_at" timestamp with time zone,
	"override_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_assignments_slot_check" CHECK ("slot_no" >= 1),
	CONSTRAINT "machine_assignments_machine_status_check" CHECK (("status" = 'open' AND "machine_id" IS NULL) OR ("status" <> 'open' AND "machine_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "machine_risk_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"reason_kind" "machine_risk_incident_reason" NOT NULL,
	"reason_text" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_notification_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_notified_at" timestamp with time zone,
	"follow_up_due_at" timestamp with time zone,
	"follow_up_sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text
);
--> statement-breakpoint
ALTER TABLE "booking_additions" ADD CONSTRAINT "booking_additions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_additions" ADD CONSTRAINT "booking_additions_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_additions" ADD CONSTRAINT "booking_additions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_additions" ADD CONSTRAINT "booking_additions_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_pickup_representatives" ADD CONSTRAINT "booking_pickup_representatives_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_pickup_representatives" ADD CONSTRAINT "booking_pickup_representatives_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_items" ADD CONSTRAINT "delivery_note_items_delivery_note_id_delivery_notes_id_fk" FOREIGN KEY ("delivery_note_id") REFERENCES "public"."delivery_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_items" ADD CONSTRAINT "delivery_note_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_items" ADD CONSTRAINT "delivery_note_items_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_items" ADD CONSTRAINT "delivery_note_items_booking_addition_id_booking_additions_id_fk" FOREIGN KEY ("booking_addition_id") REFERENCES "public"."booking_additions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_packets" ADD CONSTRAINT "delivery_packets_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_packets" ADD CONSTRAINT "delivery_packets_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_packets" ADD CONSTRAINT "delivery_packets_handover_id_handovers_id_fk" FOREIGN KEY ("handover_id") REFERENCES "public"."handovers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_machine_checks" ADD CONSTRAINT "handover_machine_checks_handover_id_handovers_id_fk" FOREIGN KEY ("handover_id") REFERENCES "public"."handovers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_machine_checks" ADD CONSTRAINT "handover_machine_checks_assignment_id_machine_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."machine_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_machine_checks" ADD CONSTRAINT "handover_machine_checks_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_machine_checks" ADD CONSTRAINT "handover_machine_checks_checked_by_staff_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_photos" ADD CONSTRAINT "handover_photos_handover_id_handovers_id_fk" FOREIGN KEY ("handover_id") REFERENCES "public"."handovers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_photos" ADD CONSTRAINT "handover_photos_assignment_id_machine_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."machine_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_photos" ADD CONSTRAINT "handover_photos_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_photos" ADD CONSTRAINT "handover_photos_taken_by_staff_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_signatures" ADD CONSTRAINT "handover_signatures_handover_id_handovers_id_fk" FOREIGN KEY ("handover_id") REFERENCES "public"."handovers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_signatures" ADD CONSTRAINT "handover_signatures_signer_user_id_staff_users_id_fk" FOREIGN KEY ("signer_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_finalized_by_staff_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_actual_issue_corrected_by_staff_users_id_fk" FOREIGN KEY ("actual_issue_corrected_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_protocol_document_id_documents_id_fk" FOREIGN KEY ("protocol_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignment_overrides" ADD CONSTRAINT "machine_assignment_overrides_assignment_id_machine_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."machine_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignment_overrides" ADD CONSTRAINT "machine_assignment_overrides_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignment_overrides" ADD CONSTRAINT "machine_assignment_overrides_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignment_overrides" ADD CONSTRAINT "machine_assignment_overrides_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignment_overrides" ADD CONSTRAINT "machine_assignment_overrides_confirmed_by_staff_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_assigned_by_staff_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_prepared_by_staff_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_assignments" ADD CONSTRAINT "machine_assignments_released_by_staff_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_risk_incidents" ADD CONSTRAINT "machine_risk_incidents_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_risk_incidents" ADD CONSTRAINT "machine_risk_incidents_assignment_id_machine_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."machine_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_risk_incidents" ADD CONSTRAINT "machine_risk_incidents_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_risk_incidents" ADD CONSTRAINT "machine_risk_incidents_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_risk_incidents" ADD CONSTRAINT "machine_risk_incidents_resolved_by_staff_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_additions_booking_idx" ON "booking_additions" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "delivery_note_items_note_idx" ON "delivery_note_items" USING btree ("delivery_note_id");--> statement-breakpoint
CREATE INDEX "delivery_notes_process_idx" ON "delivery_notes" USING btree ("process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_packets_handover_kind_unique" ON "delivery_packets" USING btree ("handover_id","kind");--> statement-breakpoint
CREATE INDEX "delivery_packets_process_idx" ON "delivery_packets" USING btree ("process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handover_machine_checks_assignment_unique" ON "handover_machine_checks" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "handover_photos_handover_idx" ON "handover_photos" USING btree ("handover_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handover_signatures_role_unique" ON "handover_signatures" USING btree ("handover_id","role");--> statement-breakpoint
CREATE INDEX "handovers_process_idx" ON "handovers" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "machine_assignment_overrides_assignment_idx" ON "machine_assignment_overrides" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_assignments_booking_slot_unique" ON "machine_assignments" USING btree ("booking_id","slot_no");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_assignments_issued_machine_unique" ON "machine_assignments" USING btree ("machine_id") WHERE "status" = 'issued';--> statement-breakpoint
CREATE INDEX "machine_assignments_machine_idx" ON "machine_assignments" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_assignments_process_idx" ON "machine_assignments" USING btree ("process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_risk_incidents_open_unique" ON "machine_risk_incidents" USING btree ("fingerprint") WHERE "resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "machine_risk_incidents_machine_idx" ON "machine_risk_incidents" USING btree ("machine_id");