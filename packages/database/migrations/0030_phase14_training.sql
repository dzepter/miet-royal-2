CREATE TYPE "public"."training_assignment_status" AS ENUM('assigned', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."training_attempt_status" AS ENUM('in_progress', 'passed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."training_clearance_source" AS ENUM('verified_demo', 'override');--> statement-breakpoint
CREATE TYPE "public"."training_event_result" AS ENUM('accepted', 'duplicate', 'rejected', 'check_passed', 'check_failed', 'interrupted');--> statement-breakpoint
CREATE TABLE "staff_training_clearances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"definition_key" text NOT NULL,
	"source" "training_clearance_source" NOT NULL,
	"reason" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "staff_training_clearances_reason_check" CHECK ("source" <> 'override' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)),
	CONSTRAINT "staff_training_clearances_valid_check" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from")
);
--> statement-breakpoint
CREATE TABLE "training_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"path_id" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"status" "training_assignment_status" DEFAULT 'assigned' NOT NULL,
	"completed_at" timestamp with time zone,
	"round" integer DEFAULT 1 NOT NULL,
	"last_reset_at" timestamp with time zone,
	"last_reset_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_assignments_round_check" CHECK ("round" >= 1)
);
--> statement-breakpoint
CREATE TABLE "training_attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"step_key" text,
	"result" "training_event_result" NOT NULL,
	"error_code" text,
	"subject_ref" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_attempt_events_key_check" CHECK ("event_key" ~ '^[a-z][a-z0-9_.]*$'),
	CONSTRAINT "training_attempt_events_error_check" CHECK ("error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "training_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"assignment_id" uuid,
	"assignment_round" integer,
	"definition_version" integer NOT NULL,
	"status" "training_attempt_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"interrupted_at" timestamp with time zone,
	"interruption_code" text,
	"failed_check_count" integer DEFAULT 0 NOT NULL,
	"last_failed_check_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_attempts_failed_count_check" CHECK ("failed_check_count" >= 0),
	CONSTRAINT "training_attempts_interruption_check" CHECK (("status" = 'interrupted') = ("interruption_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "training_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"instructions" text NOT NULL,
	"evaluator_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"demo_path" text,
	"seed_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_definitions_key_unique" UNIQUE("key"),
	CONSTRAINT "training_definitions_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "training_definitions_evaluator_check" CHECK ("evaluator_key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "training_definitions_version_check" CHECK ("version" >= 1),
	CONSTRAINT "training_definitions_demo_path_check" CHECK ("demo_path" IS NULL OR "demo_path" ~ '^/')
);
--> statement-breakpoint
CREATE TABLE "training_feature_requirements" (
	"feature_key" text PRIMARY KEY NOT NULL,
	"definition_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"configured_by" uuid,
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_feature_requirements_key_check" CHECK ("feature_key" ~ '^[a-z][a-z0-9_.]*$')
);
--> statement-breakpoint
CREATE TABLE "training_path_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "training_path_items_sequence_check" CHECK ("sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "training_paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_paths_key_unique" UNIQUE("key"),
	CONSTRAINT "training_paths_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "demo_dataset_state" ADD COLUMN "dataset_epoch" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "demo_dataset_state" ADD COLUMN "last_reset_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_training_clearances" ADD CONSTRAINT "staff_training_clearances_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_training_clearances" ADD CONSTRAINT "staff_training_clearances_definition_key_training_definitions_key_fk" FOREIGN KEY ("definition_key") REFERENCES "public"."training_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_training_clearances" ADD CONSTRAINT "staff_training_clearances_granted_by_staff_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_training_clearances" ADD CONSTRAINT "staff_training_clearances_revoked_by_staff_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_path_id_training_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."training_paths"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_assigned_by_staff_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_last_reset_by_staff_users_id_fk" FOREIGN KEY ("last_reset_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempt_events" ADD CONSTRAINT "training_attempt_events_attempt_id_training_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."training_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_definition_id_training_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."training_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_assignment_id_training_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."training_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_superseded_by_staff_users_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_feature_requirements" ADD CONSTRAINT "training_feature_requirements_definition_key_training_definitions_key_fk" FOREIGN KEY ("definition_key") REFERENCES "public"."training_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_feature_requirements" ADD CONSTRAINT "training_feature_requirements_configured_by_staff_users_id_fk" FOREIGN KEY ("configured_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_path_items" ADD CONSTRAINT "training_path_items_path_id_training_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."training_paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_path_items" ADD CONSTRAINT "training_path_items_definition_id_training_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."training_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_training_clearances_user_idx" ON "staff_training_clearances" USING btree ("user_id","definition_key");--> statement-breakpoint
CREATE UNIQUE INDEX "training_assignments_user_path_uq" ON "training_assignments" USING btree ("user_id","path_id");--> statement-breakpoint
CREATE INDEX "training_assignments_user_idx" ON "training_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "training_attempt_events_attempt_idx" ON "training_attempt_events" USING btree ("attempt_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "training_attempts_active_uq" ON "training_attempts" USING btree ("user_id","definition_id") WHERE "status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "training_attempts_user_idx" ON "training_attempts" USING btree ("user_id","definition_id");--> statement-breakpoint
CREATE INDEX "training_attempts_assignment_idx" ON "training_attempts" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "training_path_items_sequence_uq" ON "training_path_items" USING btree ("path_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "training_path_items_definition_uq" ON "training_path_items" USING btree ("path_id","definition_id");