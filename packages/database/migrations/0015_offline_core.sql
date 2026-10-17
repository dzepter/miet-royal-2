CREATE TYPE "public"."offline_environment" AS ENUM('development', 'staging', 'demo', 'production');--> statement-breakpoint
CREATE TYPE "public"."offline_receipt_status" AS ENUM('applied', 'conflict', 'rejected');--> statement-breakpoint
CREATE TABLE "offline_access_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"session_id" uuid,
	"device_id" uuid NOT NULL,
	"app_env" "offline_environment" NOT NULL,
	"lease_secret_encrypted" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_package_at" timestamp with time zone,
	"package_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_access_leases_expiry_check" CHECK ("offline_access_leases"."expires_at" > "offline_access_leases"."issued_at"),
	CONSTRAINT "offline_access_leases_max_check" CHECK ("offline_access_leases"."expires_at" <= "offline_access_leases"."issued_at" + interval '72 hours')
);
--> statement-breakpoint
CREATE TABLE "offline_mutation_receipts" (
	"client_mutation_id" uuid PRIMARY KEY NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"app_env" "offline_environment" NOT NULL,
	"operation_type" text NOT NULL,
	"context_kind" text NOT NULL,
	"context_id" uuid NOT NULL,
	"status" "offline_receipt_status" NOT NULL,
	"result_ref" jsonb,
	"error_code" text,
	"message" text,
	"client_created_at" timestamp with time zone,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_mutation_receipts_error_check" CHECK (("offline_mutation_receipts"."status" = 'applied' AND "offline_mutation_receipts"."error_code" IS NULL) OR ("offline_mutation_receipts"."status" <> 'applied' AND "offline_mutation_receipts"."error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "offline_access_leases" ADD CONSTRAINT "offline_access_leases_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_access_leases" ADD CONSTRAINT "offline_access_leases_session_id_staff_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."staff_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_mutation_receipts" ADD CONSTRAINT "offline_mutation_receipts_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offline_access_leases_active_unique" ON "offline_access_leases" USING btree ("staff_user_id","device_id","app_env") WHERE "offline_access_leases"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "offline_access_leases_user_idx" ON "offline_access_leases" USING btree ("staff_user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "offline_mutation_receipts_context_idx" ON "offline_mutation_receipts" USING btree ("context_kind","context_id");--> statement-breakpoint
CREATE INDEX "offline_mutation_receipts_user_idx" ON "offline_mutation_receipts" USING btree ("staff_user_id","processed_at");