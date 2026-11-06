import {
  cmsEntries,
  cmsRevisions,
  type CmsEntryRow,
  type CmsRevisionRow,
  type DatabaseExecutor,
} from '@mietroyal/database';
import {
  CMS_PRIVACY_PATH,
  cmsPageContentSchema,
  cmsPageTypeIssues,
  cmsSiteSettingsSchema,
  type CmsSiteSettings,
} from '@mietroyal/validation/cms';
import { and, eq, isNotNull } from 'drizzle-orm';

/**
 * Phase 16 (Fundament): gemeinsame, rein lesende Zugriffe auf VERÖFFENTLICHTE
 * CMS-Inhalte. Genutzt von CMS (öffentliche Seiten), PUBLIC (Empfehlungsregeln,
 * Datenschutz-Nachweis) und REVIEWS. Entwürfe sind hier nie erreichbar.
 */

export interface PublishedEntry {
  entry: CmsEntryRow;
  revision: CmsRevisionRow;
}

/** Veröffentlichte Revision eines Eintrags nach Pfad bzw. Singleton `site_settings`; sonst `null`. */
export async function loadPublishedEntry(
  executor: DatabaseExecutor,
  target: { kind: 'site_settings' } | { path: string },
): Promise<PublishedEntry | null> {
  const where =
    'kind' in target
      ? and(eq(cmsEntries.kind, 'site_settings'), isNotNull(cmsEntries.publishedRevisionId))
      : and(eq(cmsEntries.path, target.path), isNotNull(cmsEntries.publishedRevisionId));
  const rows = await executor
    .select({ entry: cmsEntries, revision: cmsRevisions })
    .from(cmsEntries)
    .innerJoin(cmsRevisions, eq(cmsRevisions.id, cmsEntries.publishedRevisionId))
    .where(where)
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { entry: row.entry, revision: row.revision };
}

/**
 * Veröffentlichte Website-Einstellungen. Ein (theoretisch) ungültiger gespeicherter
 * Inhalt gilt als nicht veröffentlicht – fail-closed, nie halb anzeigen.
 */
export async function loadPublishedSiteSettings(
  executor: DatabaseExecutor,
): Promise<{ revisionId: string; settings: CmsSiteSettings } | null> {
  const published = await loadPublishedEntry(executor, { kind: 'site_settings' });
  if (published === null) return null;
  const parsed = cmsSiteSettingsSchema.safeParse(published.revision.content);
  if (!parsed.success) return null;
  return { revisionId: published.revision.id, settings: parsed.data };
}

/**
 * Aktuell veröffentlichte Revision der Datenschutzhinweise (Order §17) – oder `null`
 * (fail-closed): nicht veröffentlicht, kein Rechtstext-Eintrag oder Inhalt ungültig/leer.
 */
export async function loadPublishedPrivacyRevision(
  executor: DatabaseExecutor,
): Promise<{ revisionId: string; revisionNumber: number; publishedAt: Date } | null> {
  const published = await loadPublishedEntry(executor, { path: CMS_PRIVACY_PATH });
  if (published === null || published.entry.publishedAt === null) return null;
  if (published.entry.kind !== 'page' || published.entry.pageType !== 'legal') return null;
  const parsed = cmsPageContentSchema.safeParse(published.revision.content);
  if (!parsed.success || cmsPageTypeIssues('legal', parsed.data).length > 0) return null;
  return {
    revisionId: published.revision.id,
    revisionNumber: published.revision.revisionNumber,
    publishedAt: published.entry.publishedAt,
  };
}
