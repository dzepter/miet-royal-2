CREATE TYPE "public"."cms_entry_kind" AS ENUM('site_settings', 'page');--> statement-breakpoint
CREATE TYPE "public"."cms_page_type" AS ENUM('home', 'slush', 'process', 'faq', 'about', 'contact', 'legal', 'region', 'secondary_offer');--> statement-breakpoint
CREATE TYPE "public"."public_inquiry_customer_match" AS ENUM('portal_session', 'email_unique', 'new_customer', 'new_customer_email_ambiguous');--> statement-breakpoint
CREATE TABLE "cms_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "cms_entry_kind" NOT NULL,
	"page_type" "cms_page_type",
	"path" text,
	"draft_revision_id" uuid,
	"published_revision_id" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cms_entries_kind_check" CHECK (("cms_entries"."kind" = 'site_settings' AND "cms_entries"."page_type" IS NULL AND "cms_entries"."path" IS NULL) OR ("cms_entries"."kind" = 'page' AND "cms_entries"."page_type" IS NOT NULL AND "cms_entries"."path" IS NOT NULL)),
	CONSTRAINT "cms_entries_path_format" CHECK ("cms_entries"."path" IS NULL OR "cms_entries"."path" ~ '^/([a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*)?$'),
	CONSTRAINT "cms_entries_published_consistency" CHECK (("cms_entries"."published_revision_id" IS NULL) = ("cms_entries"."published_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cms_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"source_mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"source_sha256" text NOT NULL,
	"default_alt" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cms_media_source_mime_check" CHECK ("cms_media"."source_mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "cms_media_dimensions_check" CHECK ("cms_media"."width" > 0 AND "cms_media"."height" > 0)
);
--> statement-breakpoint
CREATE TABLE "cms_media_variants" (
	"media_id" uuid NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cms_media_variants_media_id_width_pk" PRIMARY KEY("media_id","width"),
	CONSTRAINT "cms_media_variants_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "cms_media_variants_mime_check" CHECK ("cms_media_variants"."mime_type" = 'image/webp')
);
--> statement-breakpoint
CREATE TABLE "cms_preview_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"access_token_hash" text NOT NULL,
	"session_token_hash" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "cms_preview_access_access_token_hash_unique" UNIQUE("access_token_hash"),
	CONSTRAINT "cms_preview_access_session_token_hash_unique" UNIQUE("session_token_hash"),
	CONSTRAINT "cms_preview_access_expiry_check" CHECK ("cms_preview_access"."expires_at" > "cms_preview_access"."created_at"),
	CONSTRAINT "cms_preview_access_session_check" CHECK (("cms_preview_access"."session_token_hash" IS NULL) = ("cms_preview_access"."consumed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cms_revision_media" (
	"revision_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	CONSTRAINT "cms_revision_media_revision_id_media_id_pk" PRIMARY KEY("revision_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "cms_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"editor_note" text,
	"based_on_revision_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cms_revisions_number_positive" CHECK ("cms_revisions"."revision_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "public_inquiry_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"customer_match" "public_inquiry_customer_match" NOT NULL,
	"contact_snapshot" jsonb NOT NULL,
	"privacy_revision_id" uuid NOT NULL,
	"privacy_acknowledged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_inquiry_submissions_client_mutation_id_unique" UNIQUE("client_mutation_id"),
	CONSTRAINT "public_inquiry_submissions_process_id_unique" UNIQUE("process_id"),
	CONSTRAINT "public_inquiry_submissions_inquiry_id_unique" UNIQUE("inquiry_id")
);
--> statement-breakpoint
ALTER TABLE "cms_entries" ADD CONSTRAINT "cms_entries_draft_revision_id_cms_revisions_id_fk" FOREIGN KEY ("draft_revision_id") REFERENCES "public"."cms_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_entries" ADD CONSTRAINT "cms_entries_published_revision_id_cms_revisions_id_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."cms_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_entries" ADD CONSTRAINT "cms_entries_published_by_staff_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_media" ADD CONSTRAINT "cms_media_uploaded_by_staff_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_media_variants" ADD CONSTRAINT "cms_media_variants_media_id_cms_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."cms_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_preview_access" ADD CONSTRAINT "cms_preview_access_entry_id_cms_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."cms_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_preview_access" ADD CONSTRAINT "cms_preview_access_revision_id_cms_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."cms_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_preview_access" ADD CONSTRAINT "cms_preview_access_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_revision_media" ADD CONSTRAINT "cms_revision_media_revision_id_cms_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."cms_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_revision_media" ADD CONSTRAINT "cms_revision_media_media_id_cms_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."cms_media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_revisions" ADD CONSTRAINT "cms_revisions_entry_id_cms_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."cms_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_revisions" ADD CONSTRAINT "cms_revisions_based_on_revision_id_cms_revisions_id_fk" FOREIGN KEY ("based_on_revision_id") REFERENCES "public"."cms_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_revisions" ADD CONSTRAINT "cms_revisions_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_inquiry_submissions" ADD CONSTRAINT "public_inquiry_submissions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_inquiry_submissions" ADD CONSTRAINT "public_inquiry_submissions_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_inquiry_submissions" ADD CONSTRAINT "public_inquiry_submissions_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_inquiry_submissions" ADD CONSTRAINT "public_inquiry_submissions_privacy_revision_id_cms_revisions_id_fk" FOREIGN KEY ("privacy_revision_id") REFERENCES "public"."cms_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cms_entries_path_unique" ON "cms_entries" USING btree ("path") WHERE "cms_entries"."path" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cms_entries_site_settings_singleton" ON "cms_entries" USING btree ("kind") WHERE "cms_entries"."kind" = 'site_settings';--> statement-breakpoint
CREATE INDEX "cms_preview_access_expires_idx" ON "cms_preview_access" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cms_revision_media_media_idx" ON "cms_revision_media" USING btree ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_revisions_entry_number_unique" ON "cms_revisions" USING btree ("entry_id","revision_number");--> statement-breakpoint
CREATE INDEX "public_inquiry_submissions_customer_idx" ON "public_inquiry_submissions" USING btree ("customer_id");--> statement-breakpoint
-- Phase 16 (CMS, Order §6): Revisionen sind immutable – jede Änderung ist eine neue Revision.
CREATE FUNCTION cms_revisions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cms_revisions sind unveränderlich (Revision %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER cms_revisions_no_update BEFORE UPDATE ON "cms_revisions"
  FOR EACH ROW EXECUTE FUNCTION cms_revisions_immutable();
