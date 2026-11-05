import {
  deliveryNotes,
  documents,
  handovers,
  orderConfirmations,
  rentalReturns,
  type Database,
  type DocumentRow,
} from '@mietroyal/database';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { VisibleBooking } from './visibility.ts';
import {
  PORTAL_DOCUMENT_FILENAMES,
  PORTAL_DOCUMENT_LABELS,
  type PortalDocumentType,
  type PortalDocumentView,
} from './views.ts';

/**
 * Phase 15 (Order §23/§24, Design §2.3): Dokumente einer sichtbaren Buchung –
 * ausschließlich FINALE und KUNDENRELEVANTE Dokumente:
 *
 * - `offer`: genau die angenommene Angebotsversion (`offer_version_id` der
 *   Buchung) – keine supersedeten Versionen;
 * - `order_confirmation`: nur nach Freigabe (`approved|queued|sent|failed`;
 *   `prepared` ist Entwurf);
 * - `delivery_note` / `handover_protocol`: nur bei finalisierter Übergabe;
 * - `return_protocol`: nur bei finalisierter Rückgabe.
 *
 * Alle zusätzlich `documents.process_id = Vorgang der Buchung` und
 * `finalized_at IS NOT NULL`. Storage-Key/SHA/Byte-Größe verlassen den Server nie.
 */

export interface PortalDocument {
  view: PortalDocumentView;
  row: DocumentRow;
}

const CONFIRMATION_RELEASED_STATUSES = ['approved', 'queued', 'sent', 'failed'] as const;

/** Kandidaten-Dokument-IDs je Typ aus den Fachtabellen (noch ohne documents-Prüfung). */
async function candidateIds(
  db: Database,
  visible: VisibleBooking,
): Promise<{ id: string; type: PortalDocumentType }[]> {
  const bookingId = visible.booking.id;
  const found: { id: string; type: PortalDocumentType }[] = [];

  const offers = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.type, 'offer'),
        eq(documents.offerVersionId, visible.booking.offerVersionId),
        eq(documents.processId, visible.booking.processId),
      ),
    );
  for (const row of offers) found.push({ id: row.id, type: 'offer' });

  const confirmations = await db
    .select({ documentId: orderConfirmations.documentId })
    .from(orderConfirmations)
    .where(
      and(
        eq(orderConfirmations.bookingId, bookingId),
        inArray(orderConfirmations.status, [...CONFIRMATION_RELEASED_STATUSES]),
        isNotNull(orderConfirmations.documentId),
      ),
    );
  for (const row of confirmations) {
    if (row.documentId !== null) found.push({ id: row.documentId, type: 'order_confirmation' });
  }

  const finalizedHandovers = await db
    .select({ protocolDocumentId: handovers.protocolDocumentId })
    .from(handovers)
    .where(and(eq(handovers.bookingId, bookingId), eq(handovers.status, 'finalized')));
  const handoverFinalized = finalizedHandovers.length > 0;
  for (const row of finalizedHandovers) {
    if (row.protocolDocumentId !== null) {
      found.push({ id: row.protocolDocumentId, type: 'handover_protocol' });
    }
  }
  if (handoverFinalized) {
    const notes = await db
      .select({ documentId: deliveryNotes.documentId })
      .from(deliveryNotes)
      .where(
        and(
          eq(deliveryNotes.bookingId, bookingId),
          eq(deliveryNotes.status, 'final'),
          isNotNull(deliveryNotes.documentId),
        ),
      );
    for (const row of notes) {
      if (row.documentId !== null) found.push({ id: row.documentId, type: 'delivery_note' });
    }
  }

  const finalizedReturns = await db
    .select({ protocolDocumentId: rentalReturns.protocolDocumentId })
    .from(rentalReturns)
    .where(and(eq(rentalReturns.bookingId, bookingId), eq(rentalReturns.status, 'finalized')));
  for (const row of finalizedReturns) {
    if (row.protocolDocumentId !== null) {
      found.push({ id: row.protocolDocumentId, type: 'return_protocol' });
    }
  }
  return found;
}

/** Alle Portal-Dokumente der Buchung (Reihenfolge: Erstellungszeit). */
export async function listPortalDocuments(
  db: Database,
  visible: VisibleBooking,
): Promise<PortalDocument[]> {
  const candidates = await candidateIds(db, visible);
  if (candidates.length === 0) return [];
  const ids = [...new Set(candidates.map((c) => c.id))];
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(
        inArray(documents.id, ids),
        eq(documents.processId, visible.booking.processId),
        isNotNull(documents.finalizedAt),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: PortalDocument[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    const row = byId.get(candidate.id);
    if (row === undefined) continue;
    // Typ des Dokuments muss zur Fachquelle passen (kein Dokument „umgewidmet“).
    if (row.type !== candidate.type) continue;
    seen.add(candidate.id);
    result.push({
      row,
      view: {
        id: row.id,
        type: candidate.type,
        label: PORTAL_DOCUMENT_LABELS[candidate.type],
        createdAt: row.createdAt.toISOString(),
      },
    });
  }
  return result.sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime());
}

/** Ein Dokument der Buchung – nur wenn es in `listPortalDocuments` enthalten ist (sonst null ⇒ 404). */
export async function resolvePortalDocument(
  db: Database,
  visible: VisibleBooking,
  documentId: string,
): Promise<PortalDocument | null> {
  const all = await listPortalDocuments(db, visible);
  return all.find((document) => document.row.id === documentId) ?? null;
}

/** Sicherer Download-Dateiname: nur `[a-z0-9-]` + `.pdf` (Order §24). */
export function portalDocumentFilename(processNumber: string, type: PortalDocumentType): string {
  const prefix = processNumber.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const base = PORTAL_DOCUMENT_FILENAMES[type];
  return `${prefix === '' ? '' : `${prefix}-`}${base}.pdf`;
}
