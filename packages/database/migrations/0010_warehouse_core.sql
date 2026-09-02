CREATE TYPE "public"."inventory_movement_kind" AS ENUM('initial', 'incoming', 'issue', 'return', 'inventory_adjustment');--> statement-breakpoint
CREATE TYPE "public"."inventory_stocktake_status" AS ENUM('completed', 'pending_approval', 'approved');--> statement-breakpoint
CREATE TYPE "public"."machine_location_kind" AS ENUM('warehouse', 'customer', 'staff', 'repair', 'other');--> statement-breakpoint
CREATE TYPE "public"."machine_status" AS ENUM('ready', 'rented', 'reserved', 'cleaning', 'repair', 'out_of_service');--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"current_stock" integer,
	"min_stock" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_min_stock_check" CHECK ("min_stock" IS NULL OR "min_stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" "inventory_movement_kind" NOT NULL,
	"quantity_delta" integer NOT NULL,
	"resulting_stock" integer NOT NULL,
	"stocktake_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_delta_check" CHECK ("kind" = 'initial' OR "quantity_delta" <> 0),
	CONSTRAINT "inventory_movements_resulting_check" CHECK ("resulting_stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_stocktake_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stocktake_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"system_stock" integer,
	"counted_stock" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stocktake_items_counted_check" CHECK ("counted_stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_stocktakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "inventory_stocktake_status" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "machine_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_blocks_range_check" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "machine_blocks_reason_check" CHECK (length(btrim("reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_code" text NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "machine_status" DEFAULT 'ready' NOT NULL,
	"location_kind" "machine_location_kind" DEFAULT 'warehouse' NOT NULL,
	"location_note" text,
	"purchase_date" date,
	"weight_grams" integer,
	"qr_token" text NOT NULL,
	"reference_photo_key" text,
	"reference_photo_mime" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_code_format_check" CHECK ("machine_code" ~ '^MR-[0-9]{2}-[0-9]{2}-[0-9]{2,}$')
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stocktake_id_inventory_stocktakes_id_fk" FOREIGN KEY ("stocktake_id") REFERENCES "public"."inventory_stocktakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stocktake_items" ADD CONSTRAINT "inventory_stocktake_items_stocktake_id_inventory_stocktakes_id_fk" FOREIGN KEY ("stocktake_id") REFERENCES "public"."inventory_stocktakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stocktake_items" ADD CONSTRAINT "inventory_stocktake_items_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stocktakes" ADD CONSTRAINT "inventory_stocktakes_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stocktakes" ADD CONSTRAINT "inventory_stocktakes_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_blocks" ADD CONSTRAINT "machine_blocks_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_blocks" ADD CONSTRAINT "machine_blocks_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_blocks" ADD CONSTRAINT "machine_blocks_lifted_by_staff_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_product_unique" ON "inventory_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_item_idx" ON "inventory_movements" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stocktake_items_unique" ON "inventory_stocktake_items" USING btree ("stocktake_id","item_id");--> statement-breakpoint
CREATE INDEX "machine_blocks_machine_idx" ON "machine_blocks" USING btree ("machine_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_code_unique" ON "machines" USING btree ("machine_code");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_qr_token_unique" ON "machines" USING btree ("qr_token");--> statement-breakpoint
CREATE INDEX "machines_product_idx" ON "machines" USING btree ("product_id");--> statement-breakpoint
-- Verbindlicher initialer Miet-Royal-Maschinenbestand (Phase-5-Order §2/§3):
-- 1×8 L: 2 · 2×8 L: 1 · 1×10 L: 6 · 2×10 L: 2 = 11 physische Maschinen.
-- Kaufdatum/Gewicht bleiben NULL (keine Werte erfinden, Order §4); der
-- QR-Identifier wird zufällig/opak erzeugt (Order §10).
INSERT INTO "machines" ("machine_code", "product_id", "qr_token")
SELECT v.code, p.id, md5(gen_random_uuid()::text || clock_timestamp()::text) || md5(gen_random_uuid()::text)
FROM (VALUES
  ('MR-08-01-01', 'slush-1x8'),
  ('MR-08-01-02', 'slush-1x8'),
  ('MR-08-02-01', 'slush-2x8'),
  ('MR-10-01-01', 'slush-1x10'),
  ('MR-10-01-02', 'slush-1x10'),
  ('MR-10-01-03', 'slush-1x10'),
  ('MR-10-01-04', 'slush-1x10'),
  ('MR-10-01-05', 'slush-1x10'),
  ('MR-10-01-06', 'slush-1x10'),
  ('MR-10-02-01', 'slush-2x10'),
  ('MR-10-02-02', 'slush-2x10')
) AS v(code, slug)
JOIN "products" p ON p.slug = v.slug
ON CONFLICT ("machine_code") DO NOTHING;--> statement-breakpoint
-- Bekannte Lagerartikel (Order §25) auf Basis der Phase-3-Produkte.
-- current_stock/min_stock bleiben NULL: "Noch nicht initial erfasst" bzw.
-- "Mindestbestand nicht festgelegt" (Order §27/§28 – nichts erfinden).
INSERT INTO "inventory_items" ("product_id")
SELECT p.id FROM "products" p
WHERE p.slug IN (
  'sirup-wassermelone', 'sirup-kirsche', 'sirup-waldmeister',
  'sirup-blaue-himbeere', 'becher-25', 'strohhalme-25', 'mischkanister-6l'
)
ON CONFLICT ("product_id") DO NOTHING;
