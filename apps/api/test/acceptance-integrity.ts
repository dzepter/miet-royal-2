/**
 * Phase 18 (Gesamt-Abnahme, Order Abschnitt C „Datenintegrität“): wiederverwendbare
 * SQL-Invarianten, die nach jedem Abnahmeszenario gegen die Testdatenbank laufen.
 *
 * Jede MUSS-Prüfung liefert im konsistenten Zustand 0 Zeilen: keine verwaisten
 * weichen Referenzen (Spalten ohne FK), keine widersprüchlichen Statuskombinationen,
 * keine Doppelobjekte (Mails, Transfers, Dokumente, ausgegebene Maschinen), keine
 * Geisterreservierungen nach Storno, keine liegengebliebenen Jobs/Quittungen.
 *
 * Die Prüfung ersetzt keine fachliche Erwartung des einzelnen Szenarios – sie ist
 * der systemweite Backstop (Karten A §4, B B4/C4/D4, E §4.3 der Phase-18-Analyse).
 * Einzelne Prüfungen können per `skip` ausgenommen werden, wenn ein Szenario den
 * Zustand bewusst herstellt (z. B. noch nicht verarbeitete Webhook-Ereignisse) –
 * jede Ausnahme muss im Test begründet sein.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { StorageProvider } from '@mietroyal/integrations';

export interface IntegrityCheck {
  /** Stabiler Name (für `skip` und Fehlermeldungen). */
  name: string;
  sql: string;
}

export interface IntegrityViolation {
  check: string;
  rows: Record<string, unknown>[];
}

const RESEND_KEYS = `idempotency_key NOT LIKE '%:resend:%' AND idempotency_key NOT LIKE '%:retry:%'`;

export const INTEGRITY_CHECKS: readonly IntegrityCheck[] = [
  // ── A. Vorgang/Status ───────────────────────────────────────────────────────
  {
    name: 'process_status_timestamps',
    sql: `SELECT id, process_number, main_status FROM processes
          WHERE (main_status='completed' AND completed_at IS NULL)
             OR (main_status='cancelled' AND cancelled_at IS NULL)`,
  },
  {
    name: 'cancellation_without_cancelled_process',
    sql: `SELECT c.id, p.process_number, p.main_status FROM cancellations c
          JOIN processes p ON p.id=c.process_id
          WHERE p.main_status<>'cancelled' AND c.reopened_at IS NULL`,
  },
  {
    name: 'cancelled_process_without_cancellation_row',
    sql: `SELECT p.id, p.process_number FROM processes p
          JOIN bookings b ON b.process_id=p.id
          LEFT JOIN cancellations c ON c.process_id=p.id
          WHERE p.main_status='cancelled' AND c.id IS NULL`,
  },
  {
    name: 'cancelled_process_holds_machines',
    sql: `SELECT ma.id, ma.status, ma.machine_id FROM machine_assignments ma
          JOIN processes p ON p.id=ma.process_id
          WHERE p.main_status='cancelled' AND (ma.status IN ('assigned','prepared','issued') OR ma.machine_id IS NOT NULL)`,
  },
  {
    name: 'cancelled_process_scheduled_appointments',
    sql: `SELECT a.id, a.kind FROM appointments a JOIN processes p ON p.id=a.process_id
          WHERE p.main_status='cancelled' AND a.status='scheduled'`,
  },
  {
    name: 'cancelled_process_open_risk_incidents',
    sql: `SELECT i.id FROM machine_risk_incidents i JOIN processes p ON p.id=i.process_id
          WHERE p.main_status='cancelled' AND i.resolved_at IS NULL`,
  },
  {
    name: 'cancelled_with_issued_or_returned_assignment',
    sql: `SELECT c.id, a.id AS assignment_id, a.status FROM cancellations c
          JOIN machine_assignments a ON a.process_id=c.process_id
          WHERE c.reopened_at IS NULL AND a.status IN ('issued','returned')`,
  },
  {
    name: 'cancelled_with_finalized_handover_or_return',
    sql: `SELECT c.id FROM cancellations c JOIN handovers h ON h.booking_id=c.booking_id WHERE h.status='finalized'
          UNION ALL
          SELECT c.id FROM cancellations c JOIN rental_returns r ON r.booking_id=c.booking_id`,
  },
  {
    name: 'cancelled_tour_stops_not_skipped',
    sql: `SELECT s.id FROM tour_stops s
          JOIN appointments a ON a.id=s.appointment_id
          JOIN tours t ON t.id=s.tour_id
          WHERE a.status='cancelled' AND s.skipped_at IS NULL AND s.released_at IS NULL
            AND t.status IN ('draft','ready','active')`,
  },
  {
    name: 'completed_process_active_assignments',
    sql: `SELECT a.id, a.status FROM machine_assignments a JOIN processes p ON p.id=a.process_id
          WHERE p.main_status='completed' AND a.status IN ('assigned','prepared','issued')`,
  },
  {
    name: 'completed_process_open_appointments',
    sql: `SELECT a.id, a.kind, a.status FROM appointments a JOIN processes p ON p.id=a.process_id
          WHERE p.main_status='completed' AND a.status NOT IN ('completed','cancelled')`,
  },

  // ── B. Maschinen / Zuordnungen ──────────────────────────────────────────────
  {
    name: 'issued_machine_duplicate',
    sql: `SELECT machine_id, count(*) FROM machine_assignments WHERE status='issued' GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'assignment_slot_duplicate',
    sql: `SELECT booking_id, slot_no, count(*) FROM machine_assignments GROUP BY 1,2 HAVING count(*)>1`,
  },
  {
    name: 'assignment_open_machine_consistency',
    sql: `SELECT id, status, machine_id FROM machine_assignments WHERE (status='open')<>(machine_id IS NULL)`,
  },
  {
    name: 'issued_assignment_machine_not_rented',
    sql: `SELECT ma.id, m.machine_code, m.status FROM machine_assignments ma JOIN machines m ON m.id=ma.machine_id
          WHERE ma.status='issued' AND m.status<>'rented'`,
  },
  {
    name: 'rented_machine_without_issued_assignment',
    sql: `SELECT m.id, m.machine_code FROM machines m WHERE m.status='rented'
          AND NOT EXISTS (SELECT 1 FROM machine_assignments ma WHERE ma.machine_id=m.id AND ma.status='issued')`,
  },
  {
    name: 'reserved_machine_without_prepared_assignment',
    sql: `SELECT m.id, m.machine_code FROM machines m WHERE m.status='reserved'
          AND NOT EXISTS (SELECT 1 FROM machine_assignments ma WHERE ma.machine_id=m.id AND ma.status='prepared')`,
  },
  {
    name: 'cleaning_state_inconsistent',
    sql: `SELECT id, machine_code, status, cleaning_since FROM machines
          WHERE (status='cleaning' AND cleaning_since IS NULL) OR (status='ready' AND cleaning_since IS NOT NULL)`,
  },
  {
    name: 'finalized_return_assignment_still_issued',
    sql: `SELECT r.id, ma.id AS assignment_id FROM rental_returns r
          JOIN machine_assignments ma ON ma.booking_id=r.booking_id
          WHERE r.status='finalized' AND ma.status='issued'`,
  },
  {
    name: 'override_without_reason',
    sql: `SELECT id FROM machine_assignment_overrides WHERE length(trim(reason))=0`,
  },
  {
    name: 'override_active_duplicate_per_assignment',
    sql: `SELECT assignment_id, count(*) FROM machine_assignment_overrides WHERE archived_at IS NULL GROUP BY 1 HAVING count(*)>1`,
  },

  // ── C. Übergabe / Rückgabe / Schaden / Dokumente ────────────────────────────
  {
    name: 'finalized_handover_incomplete',
    sql: `SELECT id FROM handovers WHERE status='finalized'
          AND (protocol_document_id IS NULL OR finalized_at IS NULL OR finalized_by IS NULL)`,
  },
  {
    name: 'finalized_handover_signatures',
    sql: `SELECT h.id FROM handovers h WHERE h.status='finalized'
          AND (SELECT count(DISTINCT role) FROM handover_signatures s WHERE s.handover_id=h.id)<>2`,
  },
  {
    name: 'finalized_handover_assignment_without_photo',
    sql: `SELECT a.id FROM machine_assignments a JOIN handovers h ON h.booking_id=a.booking_id
          WHERE h.status='finalized' AND a.machine_id IS NOT NULL AND a.status IN ('issued','returned')
            AND NOT EXISTS (SELECT 1 FROM handover_photos p WHERE p.assignment_id=a.id)`,
  },
  {
    name: 'finalized_handover_delivery_note_not_final',
    sql: `SELECT d.id FROM delivery_notes d JOIN handovers h ON h.booking_id=d.booking_id
          WHERE h.status='finalized' AND (d.status<>'final' OR d.document_id IS NULL)`,
  },
  {
    name: 'finalized_return_incomplete',
    sql: `SELECT id FROM rental_returns WHERE status='finalized'
          AND (protocol_document_id IS NULL OR actual_return_at IS NULL OR finalized_at IS NULL OR returner_phone IS NOT NULL)`,
  },
  {
    name: 'finalized_return_signatures',
    sql: `SELECT r.id FROM rental_returns r WHERE r.status='finalized'
          AND (SELECT count(DISTINCT role) FROM return_signatures s WHERE s.return_id=r.id)<>2`,
  },
  {
    name: 'finalized_return_machine_checks_missing',
    sql: `SELECT rm.id FROM return_machines rm JOIN rental_returns r ON r.id=rm.return_id
          WHERE r.status='finalized' AND (rm.accessory_complete IS NULL OR rm.cleanliness_checked_at IS NULL OR rm.returned_at IS NULL)`,
  },
  {
    name: 'cleanup_fee_snapshot_inconsistent',
    sql: `SELECT id, cleanup_required, cleanup_fee_snapshot_cents FROM return_machines
          WHERE (cleanup_fee_snapshot_cents IS NOT NULL AND cleanup_fee_snapshot_cents<>7500)
             OR (cleanup_required=true AND cleanup_fee_snapshot_cents IS NULL)`,
  },
  {
    name: 'damage_without_marker_or_photo_after_finalization',
    sql: `SELECT d.id FROM machine_damages d JOIN rental_returns r ON r.id=d.return_id
          WHERE r.status='finalized'
            AND (NOT EXISTS (SELECT 1 FROM damage_markers m WHERE m.damage_id=d.id)
                 OR NOT EXISTS (SELECT 1 FROM damage_photos p WHERE p.damage_id=d.id))`,
  },
  {
    name: 'damage_reference_inconsistent',
    sql: `SELECT d.id FROM machine_damages d JOIN return_machines rm ON rm.id=d.return_machine_id
          WHERE rm.return_id<>d.return_id OR rm.machine_id<>d.machine_id`,
  },
  {
    name: 'return_damage_not_activated_after_finalization',
    sql: `SELECT d.id FROM machine_damages d JOIN rental_returns r ON r.id=d.return_id
          WHERE r.status='finalized' AND d.origin='return' AND d.activated_at IS NULL`,
  },
  {
    name: 'damage_photo_machine_mismatch',
    sql: `SELECT p.id FROM damage_photos p JOIN machine_damages d ON d.id=p.damage_id WHERE p.machine_id<>d.machine_id`,
  },
  {
    name: 'documents_not_finalized',
    sql: `SELECT id, type FROM documents WHERE finalized_at IS NULL`,
  },
  {
    name: 'documents_orphan_process',
    sql: `SELECT d.id, d.type FROM documents d LEFT JOIN processes p ON p.id=d.process_id WHERE p.id IS NULL`,
  },
  {
    name: 'documents_booking_mismatch',
    sql: `SELECT d.id FROM documents d WHERE d.booking_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id=d.booking_id AND b.process_id=d.process_id)`,
  },
  {
    name: 'documents_duplicate_per_process',
    sql: `SELECT process_id, type, count(*) FROM documents
          WHERE type IN ('order_confirmation','delivery_note','handover_protocol','return_protocol')
          GROUP BY 1,2 HAVING count(*)>1`,
  },
  {
    name: 'protocol_reference_without_document',
    sql: `SELECT h.id FROM handovers h LEFT JOIN documents d ON d.id=h.protocol_document_id WHERE h.protocol_document_id IS NOT NULL AND d.id IS NULL
          UNION ALL
          SELECT r.id FROM rental_returns r LEFT JOIN documents d ON d.id=r.protocol_document_id WHERE r.protocol_document_id IS NOT NULL AND d.id IS NULL
          UNION ALL
          SELECT n.id FROM delivery_notes n LEFT JOIN documents d ON d.id=n.document_id WHERE n.document_id IS NOT NULL AND d.id IS NULL
          UNION ALL
          SELECT c.id FROM order_confirmations c LEFT JOIN documents d ON d.id=c.document_id WHERE c.document_id IS NOT NULL AND d.id IS NULL`,
  },

  // ── D. Lager ────────────────────────────────────────────────────────────────
  {
    name: 'inventory_negative_stock',
    sql: `SELECT id, item_id, resulting_stock FROM inventory_movements WHERE resulting_stock<0`,
  },
  {
    name: 'inventory_stock_mismatch',
    sql: `SELECT i.id, i.current_stock FROM inventory_items i
          WHERE i.current_stock IS NOT NULL
            AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.item_id=i.id)
            AND i.current_stock <> (SELECT m.resulting_stock FROM inventory_movements m WHERE m.item_id=i.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`,
  },

  // ── E. Angebot / Buchung / Termine ──────────────────────────────────────────
  {
    name: 'booking_version_not_accepted',
    sql: `SELECT b.id FROM bookings b JOIN offer_versions v ON v.id=b.offer_version_id WHERE v.status<>'accepted'`,
  },
  {
    name: 'sent_offer_version_without_snapshot',
    sql: `SELECT id FROM offer_versions WHERE status IN ('sent','accepted') AND (customer_snapshot IS NULL OR sent_at IS NULL)`,
  },
  {
    name: 'offer_multiple_valid_tokens',
    sql: `SELECT offer_id, count(*) FROM offer_access_tokens WHERE revoked_at IS NULL GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'order_confirmation_without_document',
    sql: `SELECT id, status FROM order_confirmations WHERE status IN ('approved','queued','sent','failed') AND document_id IS NULL`,
  },
  {
    name: 'inquiry_submission_inconsistent',
    sql: `SELECT s.id FROM public_inquiry_submissions s
          LEFT JOIN processes p ON p.id=s.process_id
          LEFT JOIN inquiries i ON i.id=s.inquiry_id
          WHERE p.id IS NULL OR p.source<>'website' OR p.created_by IS NOT NULL OR i.id IS NULL OR i.process_id<>s.process_id`,
  },
  {
    name: 'appointment_kind_duplicate_per_booking',
    sql: `SELECT booking_id, kind, count(*) FROM appointments WHERE booking_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1`,
  },
  {
    name: 'appointment_orphan_booking',
    sql: `SELECT a.id FROM appointments a LEFT JOIN bookings b ON b.id=a.booking_id WHERE a.booking_id IS NOT NULL AND b.id IS NULL`,
  },
  {
    name: 'appointment_window_invalid',
    sql: `SELECT id FROM appointments WHERE end_at IS NOT NULL AND (start_at IS NULL OR end_at<=start_at)`,
  },
  {
    name: 'finalized_handover_appointment_not_completed',
    sql: `SELECT a.id FROM appointments a JOIN handovers h ON h.appointment_id=a.id WHERE h.status='finalized' AND a.status<>'completed'`,
  },
  {
    name: 'finalized_return_appointment_not_completed',
    sql: `SELECT a.id FROM appointments a JOIN rental_returns r ON r.return_appointment_id=a.id WHERE r.status='finalized' AND a.status<>'completed'`,
  },

  // ── F. Abrechnung / Transfer ────────────────────────────────────────────────
  {
    name: 'finalized_return_without_settlement',
    sql: `SELECT r.id FROM rental_returns r WHERE r.status='finalized'
          AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.return_id=r.id)`,
  },
  {
    name: 'settlement_for_unfinalized_return',
    sql: `SELECT s.id FROM settlements s JOIN rental_returns r ON r.id=s.return_id WHERE r.status<>'finalized'`,
  },
  {
    name: 'settlement_for_cancelled_booking',
    sql: `SELECT s.id FROM settlements s JOIN cancellations c ON c.booking_id=s.booking_id`,
  },
  {
    name: 'settlement_transferred_inconsistent',
    sql: `SELECT s.id, s.status, s.locked_at, s.accounting_transfer_id FROM settlements s
          WHERE (s.status='transferred' AND (s.locked_at IS NULL OR s.accounting_transfer_id IS NULL OR s.transferred_at IS NULL))
             OR (s.locked_at IS NOT NULL AND s.status<>'transferred')`,
  },
  {
    name: 'settlement_transferred_transfer_not_succeeded',
    sql: `SELECT s.id, t.status FROM settlements s JOIN accounting_transfers t ON t.id=s.accounting_transfer_id
          WHERE s.status='transferred' AND t.status<>'succeeded'`,
  },
  {
    name: 'transfer_succeeded_settlement_unlocked',
    sql: `SELECT s.id FROM settlements s JOIN accounting_transfers t ON t.id=s.accounting_transfer_id
          WHERE t.status='succeeded' AND s.locked_at IS NULL`,
  },
  {
    name: 'transfer_succeeded_without_reference',
    sql: `SELECT id FROM accounting_transfers WHERE status='succeeded' AND (external_reference IS NULL OR transferred_at IS NULL)`,
  },
  {
    name: 'transfer_duplicate_per_target',
    sql: `SELECT settlement_id::text AS target, count(*) FROM accounting_transfers WHERE settlement_id IS NOT NULL GROUP BY 1 HAVING count(*)>1
          UNION ALL
          SELECT cancellation_id::text, count(*) FROM accounting_transfers WHERE cancellation_id IS NOT NULL GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'settlement_payment_status_mismatch',
    sql: `SELECT s.id, s.payment_status, t.payment_status AS transfer_payment_status FROM settlements s
          JOIN accounting_transfers t ON t.id=s.accounting_transfer_id
          WHERE t.status='succeeded' AND s.payment_status IS DISTINCT FROM t.payment_status`,
  },
  {
    name: 'settlement_transferred_process_not_completed',
    sql: `SELECT s.id, p.main_status FROM settlements s JOIN processes p ON p.id=s.process_id
          WHERE s.status='transferred' AND p.main_status NOT IN ('completed','reopened')`,
  },
  {
    name: 'settlement_transferred_with_open_clarification',
    sql: `SELECT s.id FROM settlements s WHERE s.status='transferred'
          AND EXISTS (SELECT 1 FROM settlement_clarifications c WHERE c.settlement_id=s.id AND c.status='open')`,
  },
  {
    name: 'settlement_status_vs_open_blocking_clarifications',
    sql: `SELECT s.id, s.status FROM settlements s
          WHERE s.locked_at IS NULL AND s.accounting_transfer_id IS NULL AND s.status<>'clarification_required'
            AND EXISTS (SELECT 1 FROM settlement_clarifications c WHERE c.settlement_id=s.id AND c.status='open'
                        AND c.type IN ('damage_cost','missing_item_cost','customer_response'))`,
  },
  {
    name: 'damage_charge_duplicate_per_damage',
    sql: `SELECT source_id, count(*) FROM settlement_lines WHERE type='damage_charge' GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'damage_charge_without_charged_clarification',
    sql: `SELECT l.id FROM settlement_lines l WHERE l.type='damage_charge'
          AND (l.source_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM machine_damages d WHERE d.id=l.source_id)
               OR NOT EXISTS (SELECT 1 FROM settlement_clarifications c WHERE c.settlement_id=l.settlement_id
                              AND c.type='damage_cost' AND c.source_id=l.source_id AND c.status='resolved' AND c.resolution='charged'))`,
  },
  {
    name: 'clarification_for_damage_of_other_return',
    sql: `SELECT c.id FROM settlement_clarifications c JOIN settlements s ON s.id=c.settlement_id
          JOIN machine_damages d ON d.id=c.source_id WHERE c.type='damage_cost' AND d.return_id<>s.return_id`,
  },
  {
    name: 'cleanup_fee_line_without_fact',
    sql: `SELECT l.id FROM settlement_lines l JOIN return_machines rm ON rm.id=l.source_id
          WHERE l.type='cleanup_fee' AND (rm.cleanup_required=false OR l.amount_cents<>rm.cleanup_fee_snapshot_cents)`,
  },
  {
    name: 'customer_response_without_sent_notice',
    sql: `SELECT id FROM settlements WHERE customer_response_received_at IS NOT NULL AND notice_sent_at IS NULL`,
  },
  {
    name: 'open_customer_response_but_locked',
    sql: `SELECT c.id FROM settlement_clarifications c JOIN settlements s ON s.id=c.settlement_id
          WHERE c.type='customer_response' AND c.status='open' AND (s.locked_at IS NOT NULL OR s.accounting_transfer_id IS NOT NULL)`,
  },
  {
    name: 'notice_wait_inconsistent',
    sql: `SELECT s.id FROM settlements s LEFT JOIN settlement_customer_notices n ON n.settlement_id=s.id
          WHERE (s.notice_sent_at IS NOT NULL AND (n.status IS DISTINCT FROM 'sent' OR s.wait_until<>s.notice_sent_at + interval '24 hours'))
             OR (n.status='sent' AND s.notice_sent_at IS NULL)`,
  },

  // ── G. Storno ───────────────────────────────────────────────────────────────
  {
    name: 'cancellation_fee_inconsistent',
    sql: `SELECT id, fee_cents, base_cents, fee_percent, finance_status, accounting_transfer_id FROM cancellations
          WHERE (fee_cents=0 AND (finance_status<>'no_invoice' OR accounting_transfer_id IS NOT NULL))
             OR (fee_cents>0 AND finance_status='no_invoice')
             OR fee_cents<>floor((base_cents*fee_percent+50)/100)
             OR fee_percent NOT IN (0,50,100)`,
  },
  {
    name: 'cancellation_finance_status_without_transfer',
    sql: `SELECT c.id, c.finance_status, t.status FROM cancellations c
          LEFT JOIN accounting_transfers t ON t.id=c.accounting_transfer_id
          WHERE c.finance_status IN ('invoice_open','paid') AND (t.id IS NULL OR t.status<>'succeeded')`,
  },
  {
    name: 'follow_up_duplicate',
    sql: `SELECT previous_process_id, count(*) FROM process_relations WHERE kind='cancellation_follow_up' GROUP BY 1 HAVING count(*)>1`,
  },

  // ── H. Lexware / Gutschein ──────────────────────────────────────────────────
  {
    name: 'lexware_invoice_duplicate',
    sql: `SELECT lexware_invoice_id, count(*) FROM lexware_invoice_mappings WHERE lexware_invoice_id IS NOT NULL GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'lexware_mapping_succeeded_without_invoice',
    sql: `SELECT m.id FROM lexware_invoice_mappings m JOIN accounting_transfers t ON t.id=m.accounting_transfer_id
          WHERE t.status='succeeded' AND m.lexware_invoice_id IS NULL`,
  },
  {
    name: 'lexware_webhook_fingerprint_duplicate',
    sql: `SELECT fingerprint, count(*) FROM lexware_webhook_events GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'lexware_webhook_unprocessed',
    sql: `SELECT id, status FROM lexware_webhook_events WHERE status='queued'`,
  },
  {
    name: 'voucher_duplicate_per_settlement',
    sql: `SELECT origin_settlement_id, count(*) FROM vouchers WHERE origin_settlement_id IS NOT NULL GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'voucher_for_unpaid_settlement',
    sql: `SELECT v.id FROM vouchers v JOIN settlements s ON s.id=v.origin_settlement_id
          WHERE v.voucher_type IS NOT NULL AND (s.payment_status<>'paid' OR s.status<>'transferred')`,
  },
  {
    name: 'voucher_despite_financial_damage',
    sql: `SELECT v.id FROM vouchers v JOIN rental_returns r ON r.id=v.origin_return_id
          JOIN machine_damages d ON d.return_id=r.id WHERE d.requires_financial_review`,
  },
  {
    name: 'voucher_sent_with_delivery_copy',
    sql: `SELECT id FROM vouchers WHERE delivery_status='sent' AND delivery_code_ciphertext IS NOT NULL`,
  },
  {
    name: 'voucher_redeemed_without_redemption',
    sql: `SELECT v.id FROM vouchers v WHERE v.status='redeemed'
          AND NOT EXISTS (SELECT 1 FROM voucher_redemptions r WHERE r.voucher_id=v.id)`,
  },

  // ── I. Mails / Jobs / Offline / Portal / CMS ─────────────────────────────────
  {
    name: 'mail_sent_with_secret_payload',
    sql: `SELECT id, kind FROM mail_deliveries WHERE status='sent' AND secret_payload_ciphertext IS NOT NULL`,
  },
  {
    name: 'mail_duplicate_sent_per_booking_kind',
    sql: `SELECT kind, booking_id, count(*) FROM mail_deliveries
          WHERE status='sent' AND booking_id IS NOT NULL
            AND kind IN ('offer','order_confirmation','handover_protocol','return_protocol','cancellation_confirmation','invoice_delivery','voucher_delivery','settlement_damage_missing_notice')
            AND ${RESEND_KEYS}
          GROUP BY 1,2 HAVING count(*)>1`,
  },
  {
    name: 'jobs_dead',
    sql: `SELECT type, last_error, count(*) FROM integration_jobs
          WHERE status='dead' AND coalesce(last_error,'') NOT LIKE '%DEMO_DATASET_CHANGED%' GROUP BY 1,2`,
  },
  {
    name: 'jobs_processing_stale',
    sql: `SELECT id, type, locked_by, lease_expires_at FROM integration_jobs
          WHERE status='processing' AND coalesce(lease_expires_at, locked_at + interval '5 minutes') < now() - interval '1 hour'`,
  },
  {
    name: 'jobs_settlement_transfer_succeeded_duplicate',
    sql: `SELECT payload->>'settlementId' AS settlement_id, count(*) FROM integration_jobs
          WHERE type='settlement.accounting_transfer' AND status='succeeded' GROUP BY 1 HAVING count(*)>1`,
  },
  {
    name: 'offline_receipts_processing_stale',
    sql: `SELECT client_mutation_id, operation_type, processed_at FROM offline_mutation_receipts
          WHERE status='processing' AND processed_at < now() - interval '10 minutes'`,
  },
  {
    name: 'offline_receipt_conflict_without_code',
    sql: `SELECT client_mutation_id, status FROM offline_mutation_receipts WHERE status IN ('conflict','rejected') AND error_code IS NULL`,
  },
  {
    name: 'portal_session_expiry_invalid',
    sql: `SELECT id FROM customer_portal_sessions WHERE expires_at <> created_at + interval '30 days'`,
  },
  {
    name: 'portal_magic_link_consumed_after_revoked',
    sql: `SELECT id FROM customer_portal_magic_links WHERE consumed_at IS NOT NULL AND revoked_at IS NOT NULL AND consumed_at > revoked_at`,
  },
  {
    name: 'cms_published_revision_foreign_entry',
    sql: `SELECT e.id FROM cms_entries e JOIN cms_revisions r ON r.id=e.published_revision_id WHERE r.entry_id<>e.id`,
  },

  // ── J. Weiche Referenzen ohne Fremdschlüssel ────────────────────────────────
  {
    name: 'soft_reference_orphans',
    sql: `SELECT 'settlements.accounting_transfer_id' AS ref, s.id FROM settlements s LEFT JOIN accounting_transfers t ON t.id=s.accounting_transfer_id WHERE s.accounting_transfer_id IS NOT NULL AND t.id IS NULL
          UNION ALL SELECT 'settlements.invoice_mail_delivery_id', s.id FROM settlements s LEFT JOIN mail_deliveries m ON m.id=s.invoice_mail_delivery_id WHERE s.invoice_mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'cancellations.accounting_transfer_id', c.id FROM cancellations c LEFT JOIN accounting_transfers t ON t.id=c.accounting_transfer_id WHERE c.accounting_transfer_id IS NOT NULL AND t.id IS NULL
          UNION ALL SELECT 'cancellations.confirmation_mail_delivery_id', c.id FROM cancellations c LEFT JOIN mail_deliveries m ON m.id=c.confirmation_mail_delivery_id WHERE c.confirmation_mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'cancellations.invoice_mail_delivery_id', c.id FROM cancellations c LEFT JOIN mail_deliveries m ON m.id=c.invoice_mail_delivery_id WHERE c.invoice_mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'bookings.voucher_id', b.id FROM bookings b LEFT JOIN vouchers v ON v.id=b.voucher_id WHERE b.voucher_id IS NOT NULL AND v.id IS NULL
          UNION ALL SELECT 'offer_versions.voucher_id', o.id FROM offer_versions o LEFT JOIN vouchers v ON v.id=o.voucher_id WHERE o.voucher_id IS NOT NULL AND v.id IS NULL
          UNION ALL SELECT 'offers.current_version_id', o.id FROM offers o LEFT JOIN offer_versions v ON v.id=o.current_version_id WHERE o.current_version_id IS NOT NULL AND v.id IS NULL
          UNION ALL SELECT 'machine_assignments.override_id', ma.id FROM machine_assignments ma LEFT JOIN machine_assignment_overrides ov ON ov.id=ma.override_id WHERE ma.override_id IS NOT NULL AND ov.id IS NULL
          UNION ALL SELECT 'delivery_packets.return_id', d.id FROM delivery_packets d LEFT JOIN rental_returns r ON r.id=d.return_id WHERE d.return_id IS NOT NULL AND r.id IS NULL
          UNION ALL SELECT 'delivery_packets.mail_delivery_id', d.id FROM delivery_packets d LEFT JOIN mail_deliveries m ON m.id=d.mail_delivery_id WHERE d.mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'lexware_invoice_mappings.mail_delivery_id', l.id FROM lexware_invoice_mappings l LEFT JOIN mail_deliveries m ON m.id=l.mail_delivery_id WHERE l.mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'vouchers.mail_delivery_id', v.id FROM vouchers v LEFT JOIN mail_deliveries m ON m.id=v.mail_delivery_id WHERE v.mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'appointment_reminders.push_delivery_id', ar.id FROM appointment_reminders ar LEFT JOIN push_deliveries p ON p.id=ar.push_delivery_id WHERE ar.push_delivery_id IS NOT NULL AND p.id IS NULL
          UNION ALL SELECT 'appointment_reminders.mail_delivery_id', ar.id FROM appointment_reminders ar LEFT JOIN mail_deliveries m ON m.id=ar.mail_delivery_id WHERE ar.mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'mail_deliveries.conversation_message_id', m.id FROM mail_deliveries m LEFT JOIN conversation_messages cm ON cm.id=m.conversation_message_id WHERE m.conversation_message_id IS NOT NULL AND cm.id IS NULL
          UNION ALL SELECT 'order_confirmations.mail_delivery_id', c.id FROM order_confirmations c LEFT JOIN mail_deliveries m ON m.id=c.mail_delivery_id WHERE c.mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'settlement_customer_notices.mail_delivery_id', n.id FROM settlement_customer_notices n LEFT JOIN mail_deliveries m ON m.id=n.mail_delivery_id WHERE n.mail_delivery_id IS NOT NULL AND m.id IS NULL
          UNION ALL SELECT 'machines.cleaned_by', m.id FROM machines m LEFT JOIN staff_users u ON u.id=m.cleaned_by WHERE m.cleaned_by IS NOT NULL AND u.id IS NULL`,
  },
];

export interface IntegrityOptions {
  /** Namen bewusst ausgenommener Prüfungen (im Test begründen). */
  skip?: readonly string[];
}

/** Führt alle MUSS-Prüfungen aus und liefert die Verletzungen (leer = konsistent). */
export async function integrityViolations(
  pool: pg.Pool,
  options: IntegrityOptions = {},
): Promise<IntegrityViolation[]> {
  const skip = new Set(options.skip ?? []);
  for (const name of skip) {
    if (!INTEGRITY_CHECKS.some((check) => check.name === name)) {
      throw new Error(`Unbekannte Integritätsprüfung in skip: ${name}`);
    }
  }
  const violations: IntegrityViolation[] = [];
  for (const check of INTEGRITY_CHECKS) {
    if (skip.has(check.name)) continue;
    let result: pg.QueryResult<Record<string, unknown>>;
    try {
      result = await pool.query<Record<string, unknown>>(check.sql);
    } catch (error) {
      throw new Error(
        `Integritätsprüfung ${check.name} nicht ausführbar: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (result.rowCount !== null && result.rowCount > 0) {
      violations.push({ check: check.name, rows: result.rows.slice(0, 20) });
    }
  }
  return violations;
}

/**
 * Dokumente ↔ Storage: jede `documents`-Zeile muss als Objekt existieren und
 * SHA-256/Bytes müssen mit der Datenbank übereinstimmen (unveränderliche PDFs).
 */
export async function documentStorageMismatches(
  pool: pg.Pool,
  storage: StorageProvider,
): Promise<{ id: string; storageKey: string; problem: string }[]> {
  const rows = await pool.query<{
    id: string;
    storage_key: string;
    sha256: string;
    byte_size: number;
  }>(`SELECT id, storage_key, sha256, byte_size FROM documents ORDER BY created_at`);
  const problems: { id: string; storageKey: string; problem: string }[] = [];
  for (const row of rows.rows) {
    if (!(await storage.exists(row.storage_key))) {
      problems.push({ id: row.id, storageKey: row.storage_key, problem: 'fehlt im Storage' });
      continue;
    }
    const bytes = await storage.get(row.storage_key);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== row.sha256) {
      problems.push({ id: row.id, storageKey: row.storage_key, problem: 'sha256 abweichend' });
    } else if (bytes.length !== Number(row.byte_size)) {
      problems.push({ id: row.id, storageKey: row.storage_key, problem: 'byte_size abweichend' });
    }
  }
  return problems;
}

/** Kompakte Zählstände zentraler Tabellen (für Vorher/Nachher-Vergleiche in Szenarien). */
export async function tableCounts(
  pool: pg.Pool,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`Ungültiger Tabellenname: ${table}`);
    const result = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}
