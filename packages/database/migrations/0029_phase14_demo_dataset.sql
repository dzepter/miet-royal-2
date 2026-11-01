CREATE TABLE "demo_dataset_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"dataset_version" integer NOT NULL,
	"seeded_at" timestamp with time zone,
	"seeded_by" uuid,
	"last_reset_at" timestamp with time zone,
	"last_reset_by" uuid,
	"reset_in_progress" boolean DEFAULT false NOT NULL,
	"reset_started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_dataset_state_singleton" CHECK ("id" = 1),
	CONSTRAINT "demo_dataset_state_version_check" CHECK ("dataset_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "demo_seed_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"dataset_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_seed_entities_seed_key_unique" UNIQUE("seed_key"),
	CONSTRAINT "demo_seed_entities_key_check" CHECK ("seed_key" ~ '^[a-z0-9]+(\.[a-z0-9_-]+)+$')
);
--> statement-breakpoint
ALTER TABLE "demo_dataset_state" ADD CONSTRAINT "demo_dataset_state_seeded_by_staff_users_id_fk" FOREIGN KEY ("seeded_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_dataset_state" ADD CONSTRAINT "demo_dataset_state_last_reset_by_staff_users_id_fk" FOREIGN KEY ("last_reset_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_seed_entities_entity_idx" ON "demo_seed_entities" USING btree ("entity_type","entity_id");