import {
  cmsEntries,
  cmsRevisionMedia,
  cmsRevisions,
  type CmsPageType,
  type Database,
} from '@mietroyal/database';
import {
  CMS_PRIVACY_PATH,
  cmsPageContentSchema,
  cmsPageTypeIssues,
  cmsSiteSettingsSchema,
  collectCmsMediaIds,
  isValidCmsPathForPageType,
  type CmsPageContent,
  type CmsSiteSettings,
} from '@mietroyal/validation/cms';
import { and, eq, max } from 'drizzle-orm';
import type pg from 'pg';

/**
 * Phase 16 (Fundament): Test-/Seed-Helfer für VERÖFFENTLICHTE CMS-Inhalte – direkte
 * Inserts ohne CmsService (damit PUBLIC/E2E unabhängig vom CMS-Teil testen können).
 * Inhalte werden trotzdem gegen das Schema geprüft. Der CMS-Teil darf die Datei nur
 * additiv erweitern.
 */

export type CmsTestTarget =
  { kind: 'site_settings' } | { kind: 'page'; pageType: CmsPageType; path: string };

export interface CmsTestPublishInput {
  content: CmsPageContent | CmsSiteSettings;
  metaTitle?: string | null;
  metaDescription?: string | null;
  /** false ⇒ nur als Entwurf ablegen (nicht veröffentlichen). */
  publish?: boolean;
}

export async function publishCmsForTests(
  db: Database,
  target: CmsTestTarget,
  input: CmsTestPublishInput,
): Promise<{ entryId: string; revisionId: string; revisionNumber: number }> {
  if (target.kind === 'site_settings') {
    cmsSiteSettingsSchema.parse(input.content);
  } else {
    if (!isValidCmsPathForPageType(target.pageType, target.path)) {
      throw new Error(`Pfad ${target.path} passt nicht zu ${target.pageType}`);
    }
    const content = cmsPageContentSchema.parse(input.content);
    const issues = cmsPageTypeIssues(target.pageType, content);
    if (issues.length > 0) throw new Error(issues.join(' '));
  }
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(cmsEntries)
      .where(
        target.kind === 'site_settings'
          ? eq(cmsEntries.kind, 'site_settings')
          : and(eq(cmsEntries.kind, 'page'), eq(cmsEntries.path, target.path)),
      );
    let entryId = existing[0]?.id;
    if (entryId === undefined) {
      const inserted = await tx
        .insert(cmsEntries)
        .values(
          target.kind === 'site_settings'
            ? { kind: 'site_settings' }
            : { kind: 'page', pageType: target.pageType, path: target.path },
        )
        .returning({ id: cmsEntries.id });
      entryId = inserted[0]!.id;
    }
    const numbers = await tx
      .select({ value: max(cmsRevisions.revisionNumber) })
      .from(cmsRevisions)
      .where(eq(cmsRevisions.entryId, entryId));
    const revisionNumber = (numbers[0]?.value ?? 0) + 1;
    const revision = await tx
      .insert(cmsRevisions)
      .values({
        entryId,
        revisionNumber,
        content: input.content,
        metaTitle: input.metaTitle ?? null,
        metaDescription: input.metaDescription ?? null,
      })
      .returning({ id: cmsRevisions.id });
    const revisionId = revision[0]!.id;
    const mediaIds = collectCmsMediaIds(input.content);
    if (mediaIds.length > 0) {
      await tx
        .insert(cmsRevisionMedia)
        .values(mediaIds.map((mediaId) => ({ revisionId, mediaId })));
    }
    const now = new Date();
    const publish = input.publish ?? true;
    await tx
      .update(cmsEntries)
      .set({
        draftRevisionId: revisionId,
        ...(publish ? { publishedRevisionId: revisionId, publishedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(cmsEntries.id, entryId));
    return { entryId, revisionId, revisionNumber };
  });
}

/** Synthetische Datenschutzhinweise für Tests (KEIN Rechtstext). */
export const TEST_PRIVACY_CONTENT: CmsPageContent = {
  title: 'Datenschutzhinweise (Test)',
  blocks: [{ type: 'text', body: 'Synthetischer Datenschutztext für automatisierte Tests.' }],
};

export function publishPrivacyForTests(
  db: Database,
): Promise<{ entryId: string; revisionId: string; revisionNumber: number }> {
  return publishCmsForTests(
    db,
    { kind: 'page', pageType: 'legal', path: CMS_PRIVACY_PATH },
    { content: TEST_PRIVACY_CONTENT, metaTitle: 'Datenschutz' },
  );
}

/** Leert alle CMS-Tabellen (TRUNCATE umgeht die Immutability-Trigger bewusst). */
export async function truncateCmsTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    'TRUNCATE public_inquiry_submissions, cms_preview_access, cms_revision_media, cms_media_variants, cms_media, cms_revisions, cms_entries CASCADE',
  );
}
