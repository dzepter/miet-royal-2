CREATE TYPE "public"."customer_type" AS ENUM('private', 'organization');--> statement-breakpoint
CREATE TYPE "public"."process_source" AS ENUM('website', 'whatsapp', 'staff_manual', 'other');--> statement-breakpoint
CREATE TYPE "public"."process_status" AS ENUM('open', 'completed', 'reopened', 'cancelled');--> statement-breakpoint
CREATE SEQUENCE "public"."process_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "customer_type" NOT NULL,
	"first_name" text,
	"last_name" text,
	"organization_name" text,
	"contact_person" text,
	"email" text,
	"phone" text,
	"phone_normalized" text,
	"billing_street" text,
	"billing_postal_code" text,
	"billing_city" text,
	"billing_country" text,
	"vat_id" text,
	"department" text,
	"cost_center" text,
	"order_reference" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"main_status" "process_status" DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"source" "process_source" DEFAULT 'staff_manual' NOT NULL,
	"event_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"reopened_at" timestamp with time zone,
	CONSTRAINT "processes_process_number_unique" UNIQUE("process_number")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_deleted_by_staff_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_notes" ADD CONSTRAINT "process_notes_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_notes" ADD CONSTRAINT "process_notes_author_user_id_staff_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_assigned_user_id_staff_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "customers_phone_normalized_idx" ON "customers" USING btree ("phone_normalized");--> statement-breakpoint
CREATE INDEX "customers_deleted_idx" ON "customers" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "process_notes_process_idx" ON "process_notes" USING btree ("process_id","created_at");--> statement-breakpoint
CREATE INDEX "processes_customer_idx" ON "processes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "processes_status_idx" ON "processes" USING btree ("main_status","completed_at");--> statement-breakpoint
CREATE INDEX "processes_assigned_idx" ON "processes" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "processes_event_date_idx" ON "processes" USING btree ("event_date");
--> statement-breakpoint
-- Tippfehlertolerante Suche (Phase-2-Vorgabe Nr. 14): pg_trgm ist die
-- sauberste PostgreSQL-eigene Lösung; keine externe Suchmaschine.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING gin ((coalesce("first_name",'') || ' ' || coalesce("last_name",'')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_org_trgm_idx" ON "customers" USING gin ((coalesce("organization_name",'')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_email_trgm_idx" ON "customers" USING gin ((coalesce("email",'')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "processes_number_trgm_idx" ON "processes" USING gin (("process_number") gin_trgm_ops);--> statement-breakpoint
-- Vorgangsnummern sind nach Vergabe unveränderbar (MASTER_SPEC Nr. 3):
-- ein DB-Trigger verhindert jede Änderung, unabhängig vom Anwendungscode.
CREATE FUNCTION prevent_process_number_change() RETURNS trigger AS $$
BEGIN
  IF NEW.process_number IS DISTINCT FROM OLD.process_number THEN
    RAISE EXCEPTION 'process_number ist unveraenderbar';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER processes_number_immutable
BEFORE UPDATE ON "processes"
FOR EACH ROW EXECUTE FUNCTION prevent_process_number_change();
