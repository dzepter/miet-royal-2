import type { ConversationMessageRow } from '@mietroyal/database';

/**
 * Phase 15 (CHAT, Design §3/§6): Kunden-DTO einer Portalnachricht. Felder werden
 * EXPLIZIT übernommen (nie `...row`): keine Staff-Namen/-IDs, keine Provider-
 * Message-IDs, keine Storage-Keys, kein Outbox-Verweis. Fotos nur als Metadaten –
 * die Bytes liefert ausschließlich die eigentumsgeprüfte Portal-Fotoroute.
 */
export interface PortalMessagePhoto {
  id: string;
  mimeType: string;
  byteSize: number;
  deleted: boolean;
}

export interface PortalMessageView {
  id: string;
  /** Absenderseite – Mitarbeitende erscheinen nur als „Miet-Royal“. */
  from: 'customer' | 'miet_royal';
  body: string;
  /** Text gemäß Aufbewahrungsfrist entfernt (12 Berliner Kalendermonate). */
  bodyDeleted: boolean;
  createdAt: string;
  photos: PortalMessagePhoto[];
}

export function toPortalMessageView(
  row: ConversationMessageRow,
  photos: readonly PortalMessagePhoto[],
): PortalMessageView {
  return {
    id: row.id,
    from: row.direction === 'inbound' ? 'customer' : 'miet_royal',
    body: row.bodyDeletedAt === null ? row.body : '',
    bodyDeleted: row.bodyDeletedAt !== null,
    createdAt: row.createdAt.toISOString(),
    photos: photos.map((photo) => ({
      id: photo.id,
      mimeType: photo.mimeType,
      byteSize: photo.byteSize,
      deleted: photo.deleted,
    })),
  };
}
