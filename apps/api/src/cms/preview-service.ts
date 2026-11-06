import type { AppEnvironment } from '@mietroyal/config';
import { cmsEntries, cmsPreviewAccess, type Database } from '@mietroyal/database';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { generateToken, sha256Hex } from '../auth/crypto.ts';

/**
 * Phase 16 (CMS-Vorschau, Order §9, Design §2.4/§11.2.5).
 *
 * 1. Staff erzeugt einen Zugang (CmsService.createPreviewAccess) – Token im URL-Fragment.
 * 2. Web `/vorschau` löst ihn per POST ein: ATOMARES `UPDATE … WHERE access_token_hash = $1
 *    AND consumed_at IS NULL AND expires_at > now RETURNING` ⇒ einmalig; dabei entsteht ein
 *    Sitzungstoken (nur als SHA-256 gespeichert), das als HttpOnly-Cookie zurückgeht.
 * 3. Vorschau-Seite/-Medien lesen ausschließlich dieses Cookie; die Sitzung gilt bis zum
 *    absoluten Ablauf des Zugangs (~30 min) und nur für GENAU die gebundene Revision.
 *
 * Tokens erscheinen nie in Logs, Audit, Fehlerbodies oder Query-Strings. Demo und Live
 * sind getrennt, weil jede Umgebung ihre eigene Datenbank hat (ein Zugang aus DB A ist in
 * DB B unbekannt).
 */

export const CMS_PREVIEW_COOKIE_DEVELOPMENT = 'mr_cms_preview';
export const CMS_PREVIEW_COOKIE_HOST_PREFIXED = '__Host-mr_cms_preview';

/** Cookie-Name je Umgebung (`__Host-` verlangt Secure – daher nicht in development). */
export function cmsPreviewCookieName(appEnv: AppEnvironment): string {
  return appEnv === 'development'
    ? CMS_PREVIEW_COOKIE_DEVELOPMENT
    : CMS_PREVIEW_COOKIE_HOST_PREFIXED;
}

/** 32 Zufallsbytes base64url ⇒ exakt 43 Zeichen (gleiches Format wie `generateToken`). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedPreviewToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export interface CmsPreviewConsumeResult {
  sessionToken: string;
  entryId: string;
  revisionId: string;
  expiresAt: Date;
  entryKind: 'site_settings' | 'page';
  path: string | null;
}

export interface CmsPreviewSession {
  accessId: string;
  entryId: string;
  revisionId: string;
  expiresAt: Date;
}

export class CmsPreviewService {
  constructor(private readonly db: Database) {}

  /** Zugangstoken einlösen (einmalig, atomar); `null` = ungültig/abgelaufen/verbraucht. */
  async consume(accessToken: string, now = new Date()): Promise<CmsPreviewConsumeResult | null> {
    if (!isWellFormedPreviewToken(accessToken)) return null;
    const sessionToken = generateToken();
    const updated = await this.db
      .update(cmsPreviewAccess)
      .set({ consumedAt: now, sessionTokenHash: sha256Hex(sessionToken) })
      .where(
        and(
          eq(cmsPreviewAccess.accessTokenHash, sha256Hex(accessToken)),
          isNull(cmsPreviewAccess.consumedAt),
          gt(cmsPreviewAccess.expiresAt, now),
        ),
      )
      .returning({
        entryId: cmsPreviewAccess.entryId,
        revisionId: cmsPreviewAccess.revisionId,
        expiresAt: cmsPreviewAccess.expiresAt,
      });
    const access = updated[0];
    if (access === undefined) return null;
    const entries = await this.db
      .select({ kind: cmsEntries.kind, path: cmsEntries.path })
      .from(cmsEntries)
      .where(eq(cmsEntries.id, access.entryId));
    const entry = entries[0];
    if (entry === undefined) return null;
    return {
      sessionToken,
      entryId: access.entryId,
      revisionId: access.revisionId,
      expiresAt: access.expiresAt,
      entryKind: entry.kind,
      path: entry.path,
    };
  }

  /** Sitzung aus dem Cookie-Wert; `null` = unbekannt oder abgelaufen. */
  async resolveSession(sessionToken: unknown, now = new Date()): Promise<CmsPreviewSession | null> {
    if (!isWellFormedPreviewToken(sessionToken)) return null;
    const rows = await this.db
      .select({
        accessId: cmsPreviewAccess.id,
        entryId: cmsPreviewAccess.entryId,
        revisionId: cmsPreviewAccess.revisionId,
        expiresAt: cmsPreviewAccess.expiresAt,
      })
      .from(cmsPreviewAccess)
      .where(
        and(
          eq(cmsPreviewAccess.sessionTokenHash, sha256Hex(sessionToken)),
          gt(cmsPreviewAccess.expiresAt, now),
        ),
      );
    return rows[0] ?? null;
  }
}
