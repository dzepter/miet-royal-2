-- Phase-12-Finalisierung §4.3: Message-ID nur noch als SHA-256 (hex) der
-- bereits normalisiert gespeicherten Message-ID; Klartext danach entfernen.
UPDATE "inbound_mail_receipts"
   SET "message_id_hash" = encode(sha256(convert_to("message_id", 'UTF8')), 'hex')
 WHERE "message_id" IS NOT NULL AND "message_id_hash" IS NULL;--> statement-breakpoint
DROP INDEX "inbound_mail_receipts_message_id_idx";--> statement-breakpoint
ALTER TABLE "inbound_mail_receipts" DROP COLUMN "message_id";