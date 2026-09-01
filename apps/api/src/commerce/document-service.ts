import { createHash } from 'node:crypto';
import { documents, type Database, type DocumentRow } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';

/**
 * Zentrale Dokumententität (Phase-3-Vorgaben Nr. 34/35/37): finale
 * Dokumente sind IMMUTABLE – es gibt keinen Update-/Überschreibpfad;
 * jede Erzeugung legt ein neues Objekt unter einem NEUEN Storage-Key an.
 * Integrität über SHA-256; Auslieferung ausschließlich über autorisierte
 * API-Pfade (privater Storage, Vorgabe Nr. 36).
 */
export class DocumentService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
  ) {}

  async createFinalDocument(input: {
    type: 'offer' | 'order_confirmation';
    processId: string;
    offerVersionId?: string | undefined;
    bookingId?: string | undefined;
    storageKey: string;
    bytes: Buffer;
  }): Promise<DocumentRow> {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    await this.storage.put(input.storageKey, new Uint8Array(input.bytes), {
      contentType: 'application/pdf',
    });
    const inserted = await this.db
      .insert(documents)
      .values({
        type: input.type,
        processId: input.processId,
        offerVersionId: input.offerVersionId ?? null,
        bookingId: input.bookingId ?? null,
        storageKey: input.storageKey,
        sha256,
        byteSize: input.bytes.length,
        mimeType: 'application/pdf',
        finalizedAt: new Date(),
      })
      .returning();
    const row = inserted[0];
    if (row === undefined)
      throw new AuthError('CONFLICT', 'Dokument konnte nicht angelegt werden.');
    return row;
  }

  async byId(documentId: string): Promise<DocumentRow> {
    const rows = await this.db.select().from(documents).where(eq(documents.id, documentId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Dokument nicht gefunden.');
    return row;
  }

  async bytesFor(document: DocumentRow): Promise<Uint8Array> {
    const bytes = await this.storage.get(document.storageKey);
    // Integritätsprüfung beim Lesen: Manipulationen am Storage fallen auf.
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== document.sha256) {
      throw new AuthError('CONFLICT', 'Dokument-Integritätsprüfung fehlgeschlagen.');
    }
    return bytes;
  }
}
