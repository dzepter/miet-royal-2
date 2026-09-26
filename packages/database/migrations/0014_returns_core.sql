CREATE TYPE "public"."accessory_type" AS ENUM('lid', 'drip_tray');--> statement-breakpoint
CREATE TYPE "public"."damage_marker_type" AS ENUM('point', 'area');--> statement-breakpoint
CREATE TYPE "public"."damage_origin" AS ENUM('return', 'post_return_finding');--> statement-breakpoint
CREATE TYPE "public"."damage_severity" AS ENUM('light', 'medium', 'severe');--> statement-breakpoint
CREATE TYPE "public"."damage_view" AS ENUM('front', 'back', 'left', 'right');--> statement-breakpoint
CREATE TYPE "public"."missing_accessory_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."rental_return_status" AS ENUM('draft', 'finalized');--> statement-breakpoint
CREATE TABLE "damage_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"damage_id" uuid NOT NULL,
	"view" "damage_view" NOT NULL,
	"marker_type" "damage_marker_type" NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision,
	"height" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "damage_markers_xy_check" CHECK ("x" >= 0 AND "x" <= 1 AND "y" >= 0 AND "y" <= 1),
	CONSTRAINT "damage_markers_area_check" CHECK (("marker_type" = 'point' AND "width" IS NULL AND "height" IS NULL) OR ("marker_type" = 'area' AND "width" > 0 AND "height" > 0 AND "x" + "width" <= 1 AND "y" + "height" <= 1))
);
--> statement-breakpoint
CREATE TABLE "damage_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"damage_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"taken_by" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "damage_photos_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "machine_damages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"return_machine_id" uuid NOT NULL,
	"origin" "damage_origin" DEFAULT 'return' NOT NULL,
	"severity" "damage_severity" NOT NULL,
	"description" text NOT NULL,
	"requires_financial_review" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "machine_damages_description_check" CHECK (length(trim("description")) > 0),
	CONSTRAINT "machine_damages_post_return_check" CHECK ("origin" <> 'post_return_finding' OR "activated_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "missing_accessory_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"return_machine_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"accessory_type" "accessory_type" NOT NULL,
	"missing_quantity" integer NOT NULL,
	"description" text,
	"status" "missing_accessory_status" DEFAULT 'open' NOT NULL,
	"requires_financial_review" boolean DEFAULT true NOT NULL,
	"follow_up_opened_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "missing_accessory_cases_quantity_check" CHECK ("missing_quantity" >= 1),
	CONSTRAINT "missing_accessory_cases_resolved_check" CHECK ("status" <> 'resolved' OR ("resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rental_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"status" "rental_return_status" DEFAULT 'draft' NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"returner_kind" "handover_recipient_kind",
	"returner_name" text,
	"returner_phone" text,
	"returner_phone_deleted_at" timestamp with time zone,
	"return_appointment_id" uuid,
	"draft_actual_return_at" timestamp with time zone,
	"actual_return_at" timestamp with time zone,
	"original_actual_return_at" timestamp with time zone,
	"corrected_actual_return_at" timestamp with time zone,
	"corrected_by" uuid,
	"corrected_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"protocol_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rental_returns_booking_id_unique" UNIQUE("booking_id"),
	CONSTRAINT "rental_returns_finalized_check" CHECK ("status" <> 'finalized' OR ("finalized_at" IS NOT NULL AND "actual_return_at" IS NOT NULL AND "original_actual_return_at" IS NOT NULL AND "protocol_document_id" IS NOT NULL AND "returner_phone" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "return_inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"delivery_note_item_id" uuid NOT NULL,
	"inventory_item_id" uuid,
	"product_id" uuid,
	"kind" "delivery_note_item_kind" NOT NULL,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"issued_quantity" integer NOT NULL,
	"returned_unopened_quantity" integer DEFAULT 0 NOT NULL,
	"unit_price_snapshot_cents" integer NOT NULL,
	"chargeable_quantity" integer,
	"chargeable_amount_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_inventory_items_issued_check" CHECK ("issued_quantity" >= 0),
	CONSTRAINT "return_inventory_items_returned_check" CHECK ("returned_unopened_quantity" >= 0 AND "returned_unopened_quantity" <= "issued_quantity"),
	CONSTRAINT "return_inventory_items_price_check" CHECK ("unit_price_snapshot_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"expected_lids" integer NOT NULL,
	"expected_drip_trays" integer NOT NULL,
	"accessory_complete" boolean,
	"accessory_checked_by" uuid,
	"accessory_checked_at" timestamp with time zone,
	"emptied" boolean,
	"rinsed_twice" boolean,
	"nothing_dismantled" boolean,
	"cleanliness_checked_by" uuid,
	"cleanliness_checked_at" timestamp with time zone,
	"cleanup_required" boolean DEFAULT false NOT NULL,
	"cleanup_fee_snapshot_cents" integer,
	"cleanup_reason" text,
	"returned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_machines_expected_check" CHECK ("expected_lids" >= 0 AND "expected_drip_trays" >= 0),
	CONSTRAINT "return_machines_cleanup_check" CHECK (("cleanup_required" = false AND "cleanup_fee_snapshot_cents" IS NULL) OR ("cleanup_required" = true AND "cleanup_fee_snapshot_cents" > 0))
);
--> statement-breakpoint
CREATE TABLE "return_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"return_machine_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"taken_by" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_photos_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "return_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"role" "handover_signature_role" NOT NULL,
	"signer_name" text NOT NULL,
	"signer_user_id" uuid,
	"storage_key" text NOT NULL,
	"mime_type" text DEFAULT 'image/png' NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_signatures_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "technical_defects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"description" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"photo_storage_key" text,
	"photo_mime_type" text,
	"photo_byte_size" integer,
	"photo_sha256" text,
	"requires_financial_review" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technical_defects_photo_storage_key_unique" UNIQUE("photo_storage_key"),
	CONSTRAINT "technical_defects_description_check" CHECK (length(trim("description")) > 0)
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "cleaning_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "cleaned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "cleaned_by" uuid;--> statement-breakpoint
ALTER TABLE "delivery_packets" ADD COLUMN "return_id" uuid;--> statement-breakpoint
ALTER TABLE "handover_machine_checks" ADD COLUMN "existing_damages_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "damage_markers" ADD CONSTRAINT "damage_markers_damage_id_machine_damages_id_fk" FOREIGN KEY ("damage_id") REFERENCES "public"."machine_damages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_photos" ADD CONSTRAINT "damage_photos_damage_id_machine_damages_id_fk" FOREIGN KEY ("damage_id") REFERENCES "public"."machine_damages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_photos" ADD CONSTRAINT "damage_photos_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_photos" ADD CONSTRAINT "damage_photos_taken_by_staff_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_damages" ADD CONSTRAINT "machine_damages_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_damages" ADD CONSTRAINT "machine_damages_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_damages" ADD CONSTRAINT "machine_damages_return_machine_id_return_machines_id_fk" FOREIGN KEY ("return_machine_id") REFERENCES "public"."return_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_damages" ADD CONSTRAINT "machine_damages_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_damages" ADD CONSTRAINT "machine_damages_resolved_by_staff_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_accessory_cases" ADD CONSTRAINT "missing_accessory_cases_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_accessory_cases" ADD CONSTRAINT "missing_accessory_cases_return_machine_id_return_machines_id_fk" FOREIGN KEY ("return_machine_id") REFERENCES "public"."return_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_accessory_cases" ADD CONSTRAINT "missing_accessory_cases_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_accessory_cases" ADD CONSTRAINT "missing_accessory_cases_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_accessory_cases" ADD CONSTRAINT "missing_accessory_cases_resolved_by_staff_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_started_by_staff_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_return_appointment_id_appointments_id_fk" FOREIGN KEY ("return_appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_corrected_by_staff_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_finalized_by_staff_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_returns" ADD CONSTRAINT "rental_returns_protocol_document_id_documents_id_fk" FOREIGN KEY ("protocol_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inventory_items" ADD CONSTRAINT "return_inventory_items_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inventory_items" ADD CONSTRAINT "return_inventory_items_delivery_note_item_id_delivery_note_items_id_fk" FOREIGN KEY ("delivery_note_item_id") REFERENCES "public"."delivery_note_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inventory_items" ADD CONSTRAINT "return_inventory_items_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inventory_items" ADD CONSTRAINT "return_inventory_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_machines" ADD CONSTRAINT "return_machines_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_machines" ADD CONSTRAINT "return_machines_assignment_id_machine_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."machine_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_machines" ADD CONSTRAINT "return_machines_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_machines" ADD CONSTRAINT "return_machines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_machines" ADD CONSTRAINT "return_machines_accessory_checked_by_staff_users_id_fk" FOREIGN KEY ("accessory_checked_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_machines" ADD CONSTRAINT "return_machines_cleanliness_checked_by_staff_users_id_fk" FOREIGN KEY ("cleanliness_checked_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_photos" ADD CONSTRAINT "return_photos_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_photos" ADD CONSTRAINT "return_photos_return_machine_id_return_machines_id_fk" FOREIGN KEY ("return_machine_id") REFERENCES "public"."return_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_photos" ADD CONSTRAINT "return_photos_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_photos" ADD CONSTRAINT "return_photos_taken_by_staff_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_signatures" ADD CONSTRAINT "return_signatures_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_signatures" ADD CONSTRAINT "return_signatures_signer_user_id_staff_users_id_fk" FOREIGN KEY ("signer_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_defects" ADD CONSTRAINT "technical_defects_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_defects" ADD CONSTRAINT "technical_defects_return_id_rental_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."rental_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_defects" ADD CONSTRAINT "technical_defects_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_defects" ADD CONSTRAINT "technical_defects_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "damage_markers_damage_idx" ON "damage_markers" USING btree ("damage_id");--> statement-breakpoint
CREATE INDEX "damage_photos_damage_idx" ON "damage_photos" USING btree ("damage_id");--> statement-breakpoint
CREATE INDEX "machine_damages_machine_idx" ON "machine_damages" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_damages_return_idx" ON "machine_damages" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "missing_accessory_cases_return_idx" ON "missing_accessory_cases" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "missing_accessory_cases_machine_idx" ON "missing_accessory_cases" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "rental_returns_process_idx" ON "rental_returns" USING btree ("process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_inventory_items_item_unique" ON "return_inventory_items" USING btree ("return_id","delivery_note_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_machines_assignment_unique" ON "return_machines" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "return_machines_return_idx" ON "return_machines" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "return_machines_machine_idx" ON "return_machines" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "return_photos_return_machine_idx" ON "return_photos" USING btree ("return_machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_signatures_role_unique" ON "return_signatures" USING btree ("return_id","role");--> statement-breakpoint
CREATE INDEX "technical_defects_machine_idx" ON "technical_defects" USING btree ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_packets_return_kind_unique" ON "delivery_packets" USING btree ("return_id","kind") WHERE "return_id" IS NOT NULL;