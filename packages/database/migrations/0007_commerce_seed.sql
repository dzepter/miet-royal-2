INSERT INTO "products" ("slug", "name", "category", "description", "sale_unit", "default_billing_mode", "sort_order", "container_count", "container_volume_liters", "carry_persons")
VALUES
  ('slush-1x8', '1×8 L', 'machine', 'Slushmaschine mit 1 Behälter à 8 Liter.', 'Stück', 'fixed', 10, 1, 8, 1),
  ('slush-2x8', '2×8 L', 'machine', 'Slushmaschine mit 2 Behältern à 8 Liter.', 'Stück', 'fixed', 20, 2, 8, 2),
  ('slush-1x10', '1×10 L', 'machine', 'Slushmaschine mit 1 Behälter à 10 Liter.', 'Stück', 'fixed', 30, 1, 10, 1),
  ('slush-2x10', '2×10 L', 'machine', 'Slushmaschine mit 2 Behältern à 10 Liter.', 'Stück', 'fixed', 40, 2, 10, 2)
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "products" ("slug", "name", "category", "description", "sale_unit", "default_billing_mode", "sort_order")
VALUES
  ('sirup-wassermelone', 'Sirup Wassermelone', 'syrup', 'Zuckerfrei, Herkunft Deutschland. 1 L ergibt ca. 6 L fertigen Slush.', '1-L-Flasche', 'commission', 110),
  ('sirup-kirsche', 'Sirup Kirsche', 'syrup', 'Zuckerfrei, Herkunft Deutschland. 1 L ergibt ca. 6 L fertigen Slush.', '1-L-Flasche', 'commission', 120),
  ('sirup-waldmeister', 'Sirup Waldmeister', 'syrup', 'Zuckerfrei, Herkunft Deutschland. 1 L ergibt ca. 6 L fertigen Slush.', '1-L-Flasche', 'commission', 130),
  ('sirup-blaue-himbeere', 'Sirup Blaue Himbeere', 'syrup', 'Zuckerfrei, Herkunft Deutschland. 1 L ergibt ca. 6 L fertigen Slush.', '1-L-Flasche', 'commission', 140),
  ('becher-25', 'Becher (25 Stück)', 'consumable', 'Zusätzliche Becher im 25er-Pack. Geöffnete Packungen werden vollständig berechnet.', '25er-Pack', 'commission', 210),
  ('strohhalme-25', 'Strohhalme (25 Stück)', 'consumable', 'Zusätzliche Strohhalme im 25er-Pack. Geöffnete Packungen werden vollständig berechnet.', '25er-Pack', 'commission', 220),
  ('mischkanister-6l', '6-L-Mischkanister', 'purchase', 'Kunststoff, 6 L Fassungsvermögen, mit Liter-Markierung. Verbleibt aus hygienischen Gründen beim Kunden. Maximal 2 Kanister je gebuchtem Maschinenbehälter.', 'Stück', 'fixed', 310)
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "product_prices" ("product_id", "price_cents", "effective_from")
SELECT p."id", v."price_cents", TIMESTAMPTZ '2020-01-01 00:00:00+00'
FROM (VALUES
  ('slush-1x8', 6000),
  ('slush-2x8', 10000),
  ('slush-1x10', 7500),
  ('slush-2x10', 12000),
  ('sirup-wassermelone', 1200),
  ('sirup-kirsche', 1200),
  ('sirup-waldmeister', 1200),
  ('sirup-blaue-himbeere', 1200),
  ('becher-25', 250),
  ('strohhalme-25', 200),
  ('mischkanister-6l', 500)
) AS v("slug", "price_cents")
JOIN "products" p ON p."slug" = v."slug"
WHERE NOT EXISTS (
  SELECT 1 FROM "product_prices" pp WHERE pp."product_id" = p."id"
);--> statement-breakpoint
INSERT INTO "system_settings" ("key", "value")
VALUES ('pickup_public_area', '"Mainz-Hechtsheim"')
ON CONFLICT ("key") DO NOTHING;
