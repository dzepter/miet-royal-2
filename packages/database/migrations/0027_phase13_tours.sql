CREATE TYPE "public"."geocoding_status" AS ENUM('resolved', 'review_required', 'no_result');--> statement-breakpoint
CREATE TYPE "public"."tour_planning_status" AS ENUM('unplanned', 'planned', 'stale', 'infeasible');--> statement-breakpoint
CREATE TYPE "public"."tour_status" AS ENUM('draft', 'ready', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "geocoding_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address_hash" text NOT NULL,
	"address_text" text NOT NULL,
	"status" "geocoding_status" NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"display_label" text,
	"osm_ref" text,
	"candidates" jsonb,
	"provider" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_osm_ref" text,
	CONSTRAINT "geocoding_cache_resolved_check" CHECK ("status" <> 'resolved' OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tour_delay_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tour_id" uuid NOT NULL,
	"stop_id" uuid NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"predicted_arrival_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"notification_sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tour_live_locations" (
	"tour_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_meters" double precision,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tour_live_locations_lat_check" CHECK ("latitude" >= -90 AND "latitude" <= 90),
	CONSTRAINT "tour_live_locations_lon_check" CHECK ("longitude" >= -180 AND "longitude" <= 180),
	CONSTRAINT "tour_live_locations_accuracy_check" CHECK ("accuracy_meters" IS NULL OR ("accuracy_meters" >= 0 AND "accuracy_meters" <= 100000))
);
--> statement-breakpoint
CREATE TABLE "tour_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tour_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"buffer_minutes" integer DEFAULT 15 NOT NULL,
	"arrived_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"planned_arrival_at" timestamp with time zone,
	"planned_departure_at" timestamp with time zone,
	"leg_distance_meters" integer,
	"leg_duration_seconds" integer,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tour_stops_sequence_check" CHECK ("sequence" >= 1),
	CONSTRAINT "tour_stops_buffer_check" CHECK ("buffer_minutes" >= 0 AND "buffer_minutes" <= 240)
);
--> statement-breakpoint
CREATE TABLE "tours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tour_date" date NOT NULL,
	"status" "tour_status" DEFAULT 'draft' NOT NULL,
	"assigned_user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"started_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"end_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"planning_status" "tour_planning_status" DEFAULT 'unplanned' NOT NULL,
	"route_calculated_at" timestamp with time zone,
	"route_provider" text,
	"planned_distance_meters" integer,
	"planned_duration_seconds" integer,
	"planned_start_at" timestamp with time zone,
	"planned_end_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tours_started_check" CHECK (("status" <> 'active' AND "status" <> 'completed') OR "started_at" IS NOT NULL),
	CONSTRAINT "tours_ended_check" CHECK ("status" <> 'completed' OR "ended_at" IS NOT NULL),
	CONSTRAINT "tours_planned_values_check" CHECK ("planned_distance_meters" IS NULL OR "planned_distance_meters" >= 0)
);
--> statement-breakpoint
ALTER TABLE "geocoding_cache" ADD CONSTRAINT "geocoding_cache_confirmed_by_staff_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_delay_incidents" ADD CONSTRAINT "tour_delay_incidents_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_delay_incidents" ADD CONSTRAINT "tour_delay_incidents_stop_id_tour_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."tour_stops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_live_locations" ADD CONSTRAINT "tour_live_locations_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_live_locations" ADD CONSTRAINT "tour_live_locations_user_id_staff_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_stops" ADD CONSTRAINT "tour_stops_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tour_stops" ADD CONSTRAINT "tour_stops_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_assigned_user_id_staff_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_started_by_staff_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_ended_by_staff_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_cancelled_by_staff_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tours" ADD CONSTRAINT "tours_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "geocoding_cache_address_hash_unique" ON "geocoding_cache" USING btree ("address_hash");--> statement-breakpoint
CREATE INDEX "geocoding_cache_expires_idx" ON "geocoding_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tour_delay_incidents_open_stop_unique" ON "tour_delay_incidents" USING btree ("stop_id") WHERE "resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tour_delay_incidents_tour_idx" ON "tour_delay_incidents" USING btree ("tour_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tour_stops_tour_appointment_unique" ON "tour_stops" USING btree ("tour_id","appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tour_stops_open_appointment_unique" ON "tour_stops" USING btree ("appointment_id") WHERE "released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tour_stops_tour_sequence_idx" ON "tour_stops" USING btree ("tour_id","sequence");--> statement-breakpoint
CREATE INDEX "tours_date_idx" ON "tours" USING btree ("tour_date","status");--> statement-breakpoint
CREATE INDEX "tours_assigned_idx" ON "tours" USING btree ("assigned_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tours_one_active_per_user_idx" ON "tours" USING btree ("assigned_user_id") WHERE "status" = 'active';