/**
 * Customer Document Link (Phase 12, Order §13): ein sicherer, zeitlich
 * befristeter Link auf GENAU EIN unveränderliches Dokument (z. B. das
 * Rückgabeprotokoll in der Schaden-/Fehlteil-Information).
 *
 * - Token: 32 zufällige Bytes (base64url), nur als SHA-256-Hash in
 *   `customer_action_tokens` (purpose `document_view`); der Klartext existiert
 *   nur im Moment der Ausstellung (und verschlüsselt in der Outbox-Payload).
 * - Prozess-/Kundenkontext ist am Token gebunden; `resolve` liefert die
 *   Dokumentbytes nur bei gültigem, nicht widerrufenem, nicht abgelaufenem
 *   Token und zählt die Nutzung (last_used_at/use_count).
 * - Kein permanenter Storage-Link: Auslieferung ausschließlich über die
 *   öffentliche Route (Rate-Limit, neutrales 404, Pfad im Log maskiert).
 * - Gültigkeit: Der Auftrag nennt keine Dauer – konservativ 90 Tage.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  customerActionTokens,
  documents,
  type Database,
  type DatabaseExecutor,
  type DocumentRow,
} from '@mietroyal/database';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DocumentService } from '../commerce/document-service.ts';

export const DOCUMENT_LINK_VALIDITY_DAYS = 90;
const TOKEN_BYTES = 32;
/** base64url von 32 Bytes = 43 Zeichen ohne Padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashDocumentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function documentLinkExpiresAt(now: Date): Date {
  return new Date(now.getTime() + DOCUMENT_LINK_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
}

export interface IssueDocumentLinkInput {
  documentId: string;
  processId: string;
  customerId: string;
  bookingId?: string | null;
  expiresAt?: Date;
}

export class CustomerDocumentLinkService {
  constructor(
    private readonly db: Database,
    private readonly documents: DocumentService,
  ) {}

  /**
   * Token ausstellen (gern in der fachlichen Transaktion per `executor`).
   * Der Klartext wird NUR zurückgegeben – nie gespeichert, nie geloggt.
   */
  async issue(
    input: IssueDocumentLinkInput,
    executor?: DatabaseExecutor,
    now = new Date(),
  ): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = input.expiresAt ?? documentLinkExpiresAt(now);
    const inserted = await (executor ?? this.db)
      .insert(customerActionTokens)
      .values({
        purpose: 'document_view',
        tokenHash: hashDocumentToken(token),
        processId: input.processId,
        customerId: input.customerId,
        bookingId: input.bookingId ?? null,
        documentId: input.documentId,
        expiresAt,
        createdAt: now,
      })
      .returning({ id: customerActionTokens.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('Dokument-Token konnte nicht ausgestellt werden.');
    return { token, tokenId: row.id, expiresAt };
  }

  /**
   * Gültiges Token ⇒ Dokument + Bytes; sonst null (der Aufrufer antwortet
   * neutral 404 – ohne Unterscheidung zwischen unbekannt/abgelaufen/widerrufen).
   */
  async resolve(
    token: string,
    now = new Date(),
  ): Promise<{ document: DocumentRow; bytes: Uint8Array } | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const rows = await this.db
      .select({ token: customerActionTokens, document: documents })
      .from(customerActionTokens)
      .innerJoin(documents, eq(documents.id, customerActionTokens.documentId))
      .where(
        and(
          eq(customerActionTokens.tokenHash, hashDocumentToken(token)),
          eq(customerActionTokens.purpose, 'document_view'),
          isNull(customerActionTokens.revokedAt),
        ),
      );
    const hit = rows[0];
    if (hit === undefined) return null;
    if (hit.token.expiresAt.getTime() <= now.getTime()) return null;
    await this.db
      .update(customerActionTokens)
      .set({ lastUsedAt: now, useCount: sql`${customerActionTokens.useCount} + 1` })
      .where(eq(customerActionTokens.id, hit.token.id));
    const bytes = await this.documents.bytesFor(hit.document);
    return { document: hit.document, bytes };
  }

  /** Alle Dokument-Links eines Dokuments widerrufen (z. B. administrativ). */
  async revokeForDocument(documentId: string, now = new Date()): Promise<number> {
    const rows = await this.db
      .update(customerActionTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(customerActionTokens.documentId, documentId),
          eq(customerActionTokens.purpose, 'document_view'),
          isNull(customerActionTokens.revokedAt),
        ),
      )
      .returning({ id: customerActionTokens.id });
    return rows.length;
  }
}
