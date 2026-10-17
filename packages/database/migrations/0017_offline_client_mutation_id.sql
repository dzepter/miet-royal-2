ALTER TABLE "handover_photos" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "handover_signatures" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "damage_photos" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_damages" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "missing_accessory_cases" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "return_photos" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "return_signatures" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "handover_photos_client_mutation_unique" ON "handover_photos" USING btree ("client_mutation_id") WHERE "handover_photos"."client_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "handover_signatures_client_mutation_unique" ON "handover_signatures" USING btree ("client_mutation_id") WHERE "handover_signatures"."client_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "damage_photos_client_mutation_unique" ON "damage_photos" USING btree ("client_mutation_id") WHERE "damage_photos"."client_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_damages_client_mutation_unique" ON "machine_damages" USING btree ("client_mutation_id") WHERE "machine_damages"."client_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "missing_accessory_cases_client_mutation_unique" ON "missing_accessory_cases" USING btree ("client_mutation_id") WHERE "missing_accessory_cases"."client_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "return_photos_client_mutation_unique" ON "return_photos" USING btree ("client_mutation_id") WHERE "return_photos"."client_mutation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "return_signatures_client_mutation_unique" ON "return_signatures" USING btree ("client_mutation_id") WHERE "return_signatures"."client_mutation_id" IS NOT NULL;