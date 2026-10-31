CREATE TABLE "integration_rate_limits" (
	"provider" text PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"next_slot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_until" timestamp with time zone,
	"pause_kind" text,
	CONSTRAINT "integration_rate_limits_pause_check" CHECK (("paused_until" IS NULL) = ("pause_kind" IS NULL)),
	CONSTRAINT "integration_rate_limits_pause_kind_check" CHECK ("pause_kind" IS NULL OR "pause_kind" IN ('rate_limited', 'credit_limited')),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Bisherigen Lexware-Slot in die generische Tabelle übernehmen (Umgebung wird beim nächsten Reservieren gesetzt).
INSERT INTO "integration_rate_limits" ("provider", "environment", "next_slot_at")
SELECT 'lexware', 'unknown', "next_slot_at" FROM "lexware_rate_limit" WHERE "id" = 1
ON CONFLICT ("provider") DO NOTHING;--> statement-breakpoint
DROP TABLE "lexware_rate_limit" CASCADE;--> statement-breakpoint
ALTER TABLE "tour_delay_incidents" RENAME COLUMN "notification_sent_at" TO "notification_enqueued_at";