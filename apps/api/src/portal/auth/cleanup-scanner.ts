import type { Database } from '@mietroyal/database';
import { sql } from 'drizzle-orm';
import type { DueScanner } from '../../communication/scan-due.ts';

/**
 * Phase 15 (Order §52, Design §1.4): Aufräumen abgelaufener/verbrauchter/
 * widerrufener Magic Links (nach 1 Tag) und abgelaufener/widerrufener Sessions
 * (nach 7 Tagen, nur ohne verbliebene Links). Läuft im bestehenden
 * `communication.scan_due`-Lauf; idempotent; begrenzt auf 5000 Zeilen je Tabelle
 * und Lauf (Subselect mit LIMIT). Links zuerst (FK `session_id`).
 */
export const PORTAL_AUTH_CLEANUP_SCANNER_NAME = 'portal_auth_cleanup';
export const PORTAL_MAGIC_LINK_RETENTION_MS = 24 * 60 * 60 * 1000;
export const PORTAL_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 5000;

export interface PortalAuthCleanupSummary {
  magicLinksDeleted: number;
  sessionsDeleted: number;
}

export async function runPortalAuthCleanup(
  db: Database,
  now: Date,
): Promise<PortalAuthCleanupSummary> {
  const linkCutoff = new Date(now.getTime() - PORTAL_MAGIC_LINK_RETENTION_MS);
  const sessionCutoff = new Date(now.getTime() - PORTAL_SESSION_RETENTION_MS);
  const links = await db.execute(sql`
    delete from customer_portal_magic_links
    where id in (
      select id from customer_portal_magic_links
      where expires_at < ${linkCutoff}
         or consumed_at < ${linkCutoff}
         or revoked_at < ${linkCutoff}
      limit ${CLEANUP_BATCH}
    )
  `);
  const sessions = await db.execute(sql`
    delete from customer_portal_sessions
    where id in (
      select s.id from customer_portal_sessions s
      where (s.expires_at < ${sessionCutoff} or s.revoked_at < ${sessionCutoff})
        and not exists (
          select 1 from customer_portal_magic_links l where l.session_id = s.id
        )
      limit ${CLEANUP_BATCH}
    )
  `);
  return { magicLinksDeleted: links.rowCount ?? 0, sessionsDeleted: sessions.rowCount ?? 0 };
}

export function createPortalAuthCleanupScanner(deps: {
  db: Database;
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void } | undefined;
}): DueScanner {
  return {
    name: PORTAL_AUTH_CLEANUP_SCANNER_NAME,
    scanDue: async (now) => {
      const summary = await runPortalAuthCleanup(deps.db, now);
      if (summary.magicLinksDeleted > 0 || summary.sessionsDeleted > 0) {
        deps.logger?.warn({ ...summary }, 'portal.auth_cleanup');
      }
      return summary;
    },
  };
}
