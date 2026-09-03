ALTER TABLE "inventory_stocktake_items" ADD COLUMN "open_item_id" uuid;--> statement-breakpoint
-- Backfill (Phase-5-Finalisierung): je Artikel markiert genau die älteste noch
-- offene Zählung die Exklusivität; abgeschlossene/freigegebene Inventuren
-- bleiben unverändert.
UPDATE "inventory_stocktake_items" si SET "open_item_id" = si."item_id"
FROM (
  SELECT DISTINCT ON (i."item_id") i."id"
  FROM "inventory_stocktake_items" i
  JOIN "inventory_stocktakes" s ON s."id" = i."stocktake_id"
  WHERE s."status" = 'pending_approval'
  ORDER BY i."item_id", s."created_at" ASC, i."id" ASC
) oldest
WHERE si."id" = oldest."id";--> statement-breakpoint
ALTER TABLE "inventory_stocktake_items" ADD CONSTRAINT "inventory_stocktake_items_open_item_id_inventory_items_id_fk" FOREIGN KEY ("open_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stocktake_items_open_item_unique" ON "inventory_stocktake_items" USING btree ("open_item_id") WHERE "open_item_id" IS NOT NULL;