-- Korrektur erfundener Fachaussagen in den Seed-Beschreibungen (Phase-3-
-- Review): Die Ungeöffnet-Regel ist in der Order NUR für Sirupflaschen
-- definiert (§3), nicht für Becher/Strohhalme; die Hygiene-Begründung beim
-- Kanister steht nirgends in der Order (§5: „bleibt beim Kunden“).
UPDATE "products"
SET "description" = 'Zusätzliche Becher im 25er-Pack. Abrechnung als Kommission nach tatsächlichem Verbrauch.'
WHERE "slug" = 'becher-25'
  AND "description" = 'Zusätzliche Becher im 25er-Pack. Geöffnete Packungen werden vollständig berechnet.';--> statement-breakpoint
UPDATE "products"
SET "description" = 'Zusätzliche Strohhalme im 25er-Pack. Abrechnung als Kommission nach tatsächlichem Verbrauch.'
WHERE "slug" = 'strohhalme-25'
  AND "description" = 'Zusätzliche Strohhalme im 25er-Pack. Geöffnete Packungen werden vollständig berechnet.';--> statement-breakpoint
UPDATE "products"
SET "description" = 'Kunststoff, 6 L Fassungsvermögen, mit Liter-Markierung. Kaufartikel – bleibt beim Kunden. Maximal 2 Kanister je gebuchtem Maschinenbehälter.'
WHERE "slug" = 'mischkanister-6l'
  AND "description" = 'Kunststoff, 6 L Fassungsvermögen, mit Liter-Markierung. Verbleibt aus hygienischen Gründen beim Kunden. Maximal 2 Kanister je gebuchtem Maschinenbehälter.';
