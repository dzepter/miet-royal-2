import { createHash } from 'node:crypto';
import {
  documents,
  type Database,
  type DatabaseExecutor,
  type DocumentRow,
} from '@mietroyal/database';
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
    type: DocumentRow['type'];
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

  /**
   * Zweiphasige Finalisierung (Phase 6, Order §41): Bytes ZUERST in den
   * Storage laden (außerhalb der Business-Transaktion), danach die
   * Dokumentzeile innerhalb der Transaktion registrieren. Schlägt der
   * Upload fehl, entsteht kein Fachzustand; schlägt die Transaktion fehl,
   * bleibt höchstens ein unreferenziertes Storage-Objekt zurück.
   */
  async uploadBytes(storageKey: string, bytes: Buffer): Promise<{ sha256: string }> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.storage.put(storageKey, new Uint8Array(bytes), {
      contentType: 'application/pdf',
    });
    return { sha256 };
  }

  async registerUploaded(
    tx: DatabaseExecutor,
    input: {
      type: DocumentRow['type'];
      processId: string;
      bookingId?: string | undefined;
      storageKey: string;
      sha256: string;
      byteSize: number;
    },
  ): Promise<DocumentRow> {
    const inserted = await tx
      .insert(documents)
      .values({
        type: input.type,
        processId: input.processId,
        bookingId: input.bookingId ?? null,
        storageKey: input.storageKey,
        sha256: input.sha256,
        byteSize: input.byteSize,
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
