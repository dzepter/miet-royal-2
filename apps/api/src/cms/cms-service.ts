import {
  cmsEntries,
  cmsPreviewAccess,
  cmsRevisionMedia,
  cmsRevisions,
  staffUsers,
  type CmsEntryRow,
  type CmsRevisionRow,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from '@mietroyal/database';
import {
  CMS_REGION_PATH_PREFIX,
  CMS_REGION_SLUG_MAX,
  CMS_REGION_SLUG_PATTERN,
  type CmsPageTypeName,
} from '@mietroyal/validation/cms';
import { RequestValidationError } from '@mietroyal/validation';
import { and, asc, desc, eq, lt, max } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { recordSecurityEvent } from '../auth/audit.ts';
import { generateToken, sha256Hex } from '../auth/crypto.ts';
import {
  assertDraftRules,
  assertMediaExist,
  assertPublishable,
  assertRecommendationRules,
  assertTextRules,
  parseEditorNote,
  parseEntryContent,
  parseMeta,
  type CmsCheckedContent,
  type CmsEntryShape,
  type CmsMetaInput,
} from './content-rules.ts';
import { CMS_MESSAGES, CmsError } from './errors.ts';

/**
 * Phase 16 (CMS, Order §6/§9/§10/§22, Design §2): schlanke Redaktions-Logik des
 * internen Website-CMS.
 *
 * - Einträge sind stabil; jede Entwurfsänderung erzeugt eine NEUE immutable Revision
 *   (DB-Trigger verbietet UPDATE/DELETE) und setzt nur den Zeiger `draft_revision_id`.
 *   Optimistische Prüfung: `baseRevisionId` muss der aktuelle Entwurf sein, sonst 409
 *   `CMS_DRAFT_CONFLICT` – konkurrierende Änderungen werden nie still überschrieben.
 * - Veröffentlichen ist atomar: `SELECT … FOR UPDATE` auf dem Eintrag, erwartete Revision
 *   = aktueller Entwurf, alle Prüfungen, Zeiger umsetzen, `version += 1` und Audit
 *   `cms.published` in DERSELBEN Transaktion. Ein Entwurf beeinflusst die öffentliche
 *   Website nie (öffentliche Routen lesen nur `published_revision_id`).
 * - Vorschau-Zugänge: Token nur als SHA-256, ~30 min, an genau eine Revision des Eintrags
 *   gebunden; abgelaufene Zugänge werden beim Erzeugen neuer Zugänge aufgeräumt.
 * - Audit-Details tragen nur IDs, Revisionsnummern, Pfad und Quelle – nie Texte/Tokens.
 */

export const CMS_PREVIEW_TTL_MS = 30 * 60 * 1000;
/** Abgelaufene Vorschau-Zugänge werden nach einem Tag beim nächsten Erzeugen gelöscht. */
export const CMS_PREVIEW_CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
export const CMS_SITE_SETTINGS_TITLE = 'Website-Einstellungen';

export type CmsEntryStatus = 'never_published' | 'published' | 'published_with_draft_changes';
export type CmsPublishSource = 'staff' | 'bootstrap';

export interface StaffUserRef {
  id: string;
  name: string;
}

export interface StaffCmsRevision {
  revisionId: string;
  revisionNumber: number;
  content: unknown;
  metaTitle: string | null;
  metaDescription: string | null;
  editorNote: string | null;
  createdAt: string;
  createdBy: StaffUserRef | null;
}

export interface StaffCmsEntrySummary {
  id: string;
  kind: 'site_settings' | 'page';
  pageType: CmsPageTypeName | null;
  path: string | null;
  title: string;
  status: CmsEntryStatus;
  draftRevisionNumber: number;
  publishedRevisionNumber: number | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface StaffCmsEntryDetail extends StaffCmsEntrySummary {
  version: number;
  draft: StaffCmsRevision;
  published: {
    revisionId: string;
    revisionNumber: number;
    publishedAt: string;
    publishedBy: StaffUserRef | null;
  } | null;
  history: Array<{
    revisionId: string;
    revisionNumber: number;
    createdAt: string;
    createdBy: StaffUserRef | null;
    basedOnRevisionNumber: number | null;
    isDraft: boolean;
    isPublished: boolean;
  }>;
  canUnpublish: boolean;
}

export interface CmsDraftInput {
  baseRevisionId: string;
  content: unknown;
  metaTitle?: string | null | undefined;
  metaDescription?: string | null | undefined;
  editorNote?: string | null | undefined;
}

export interface CmsPreviewAccessResult {
  url: string;
  expiresAt: string;
}

export interface CmsServiceOptions {
  /** `config.mail.publicWebBaseUrl` (ohne Slash am Ende); null ⇒ Vorschau nicht verfügbar. */
  publicWebBaseUrl: string | null;
}

const UNPUBLISHABLE_PAGE_TYPES: readonly CmsPageTypeName[] = ['region', 'secondary_offer'];

function shapeOf(entry: CmsEntryRow): CmsEntryShape {
  return entry.kind === 'site_settings'
    ? { kind: 'site_settings', pageType: null }
    : { kind: 'page', pageType: entry.pageType as CmsPageTypeName };
}

function userRef(
  id: string | null,
  firstName: string | null,
  lastName: string | null,
): StaffUserRef | null {
  if (id === null) return null;
  return { id, name: `${firstName ?? ''} ${lastName ?? ''}`.trim() };
}

function statusOf(entry: CmsEntryRow): CmsEntryStatus {
  if (entry.publishedRevisionId === null) return 'never_published';
  return entry.publishedRevisionId === entry.draftRevisionId
    ? 'published'
    : 'published_with_draft_changes';
}

function titleOf(entry: CmsEntryRow, draftContent: unknown): string {
  if (entry.kind === 'site_settings') return CMS_SITE_SETTINGS_TITLE;
  const title = (draftContent as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() !== '' ? title : (entry.path ?? '');
}

function canUnpublish(entry: CmsEntryRow): boolean {
  return (
    entry.kind === 'page' &&
    entry.publishedRevisionId !== null &&
    UNPUBLISHABLE_PAGE_TYPES.includes(entry.pageType as CmsPageTypeName)
  );
}

export class CmsService {
  constructor(
    private readonly db: Database,
    private readonly options: CmsServiceOptions,
  ) {}

  // ── Lesen (Staff) ──────────────────────────────────────────────────────────

  async listEntries(): Promise<StaffCmsEntrySummary[]> {
    const draft = alias(cmsRevisions, 'draft_revision');
    const published = alias(cmsRevisions, 'published_revision');
    const rows = await this.db
      .select({
        entry: cmsEntries,
        draftNumber: draft.revisionNumber,
        draftContent: draft.content,
        publishedNumber: published.revisionNumber,
      })
      .from(cmsEntries)
      .leftJoin(draft, eq(draft.id, cmsEntries.draftRevisionId))
      .leftJoin(published, eq(published.id, cmsEntries.publishedRevisionId))
      .orderBy(asc(cmsEntries.kind), asc(cmsEntries.path));
    return rows
      .filter((row) => row.draftNumber !== null)
      .map((row) => ({
        id: row.entry.id,
        kind: row.entry.kind,
        pageType: (row.entry.pageType as CmsPageTypeName | null) ?? null,
        path: row.entry.path,
        title: titleOf(row.entry, row.draftContent),
        status: statusOf(row.entry),
        draftRevisionNumber: row.draftNumber!,
        publishedRevisionNumber: row.publishedNumber ?? null,
        publishedAt: row.entry.publishedAt?.toISOString() ?? null,
        updatedAt: row.entry.updatedAt.toISOString(),
      }));
  }

  async getEntry(
    entryId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<StaffCmsEntryDetail> {
    const entries = await executor.select().from(cmsEntries).where(eq(cmsEntries.id, entryId));
    const entry = entries[0];
    if (entry === undefined || entry.draftRevisionId === null) {
      throw new CmsError('NOT_FOUND', CMS_MESSAGES.NOT_FOUND);
    }
    const revisions = await executor
      .select({
        revision: cmsRevisions,
        userId: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(cmsRevisions)
      .leftJoin(staffUsers, eq(staffUsers.id, cmsRevisions.createdBy))
      .where(eq(cmsRevisions.entryId, entryId))
      .orderBy(desc(cmsRevisions.revisionNumber));
    const numberById = new Map(
      revisions.map((row) => [row.revision.id, row.revision.revisionNumber]),
    );
    const draftRow = revisions.find((row) => row.revision.id === entry.draftRevisionId);
    if (draftRow === undefined) throw new CmsError('NOT_FOUND', CMS_MESSAGES.NOT_FOUND);
    const publishedRow =
      entry.publishedRevisionId === null
        ? undefined
        : revisions.find((row) => row.revision.id === entry.publishedRevisionId);
    let publishedBy: StaffUserRef | null = null;
    if (entry.publishedBy !== null) {
      const users = await executor
        .select({
          id: staffUsers.id,
          firstName: staffUsers.firstName,
          lastName: staffUsers.lastName,
        })
        .from(staffUsers)
        .where(eq(staffUsers.id, entry.publishedBy));
      const user = users[0];
      publishedBy = user === undefined ? null : userRef(user.id, user.firstName, user.lastName);
    }
    const toRevision = (row: (typeof revisions)[number]): StaffCmsRevision => ({
      revisionId: row.revision.id,
      revisionNumber: row.revision.revisionNumber,
      content: row.revision.content,
      metaTitle: row.revision.metaTitle,
      metaDescription: row.revision.metaDescription,
      editorNote: row.revision.editorNote,
      createdAt: row.revision.createdAt.toISOString(),
      createdBy: userRef(row.userId, row.firstName, row.lastName),
    });
    return {
      id: entry.id,
      kind: entry.kind,
      pageType: (entry.pageType as CmsPageTypeName | null) ?? null,
      path: entry.path,
      title: titleOf(entry, draftRow.revision.content),
      status: statusOf(entry),
      draftRevisionNumber: draftRow.revision.revisionNumber,
      publishedRevisionNumber: publishedRow?.revision.revisionNumber ?? null,
      publishedAt: entry.publishedAt?.toISOString() ?? null,
      updatedAt: entry.updatedAt.toISOString(),
      version: entry.version,
      draft: toRevision(draftRow),
      published:
        publishedRow === undefined || entry.publishedAt === null
          ? null
          : {
              revisionId: publishedRow.revision.id,
              revisionNumber: publishedRow.revision.revisionNumber,
              publishedAt: entry.publishedAt.toISOString(),
              publishedBy,
            },
      history: revisions.map((row) => ({
        revisionId: row.revision.id,
        revisionNumber: row.revision.revisionNumber,
        createdAt: row.revision.createdAt.toISOString(),
        createdBy: userRef(row.userId, row.firstName, row.lastName),
        basedOnRevisionNumber:
          row.revision.basedOnRevisionId === null
            ? null
            : (numberById.get(row.revision.basedOnRevisionId) ?? null),
        isDraft: row.revision.id === entry.draftRevisionId,
        isPublished: row.revision.id === entry.publishedRevisionId,
      })),
      canUnpublish: canUnpublish(entry),
    };
  }

  async getRevision(revisionId: string): Promise<StaffCmsRevision> {
    const rows = await this.db
      .select({
        revision: cmsRevisions,
        userId: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(cmsRevisions)
      .leftJoin(staffUsers, eq(staffUsers.id, cmsRevisions.createdBy))
      .where(eq(cmsRevisions.id, revisionId));
    const row = rows[0];
    if (row === undefined) throw new CmsError('NOT_FOUND', CMS_MESSAGES.REVISION_NOT_FOUND);
    return {
      revisionId: row.revision.id,
      revisionNumber: row.revision.revisionNumber,
      content: row.revision.content,
      metaTitle: row.revision.metaTitle,
      metaDescription: row.revision.metaDescription,
      editorNote: row.revision.editorNote,
      createdAt: row.revision.createdAt.toISOString(),
      createdBy: userRef(row.userId, row.firstName, row.lastName),
    };
  }

  // ── Entwurf ───────────────────────────────────────────────────────────────

  /** Neuer Entwurf = neue immutable Revision (optimistische Prüfung über `baseRevisionId`). */
  async saveDraft(
    actorId: string,
    entryId: string,
    input: CmsDraftInput,
    now = new Date(),
  ): Promise<StaffCmsEntryDetail> {
    await this.db.transaction(async (tx) => {
      const entry = await this.lockEntry(tx, entryId);
      if (entry.draftRevisionId !== input.baseRevisionId) {
        throw new CmsError('CMS_DRAFT_CONFLICT', CMS_MESSAGES.DRAFT_CONFLICT);
      }
      const shape = shapeOf(entry);
      const checked = parseEntryContent(shape, input.content);
      const meta = parseMeta(input);
      const editorNote = parseEditorNote(input.editorNote);
      const mediaIds = await assertDraftRules(tx, shape, checked, meta);
      await this.appendRevision(tx, entry, {
        checked,
        meta,
        editorNote,
        basedOnRevisionId: null,
        createdBy: actorId,
        mediaIds,
        now,
      });
    });
    return this.getEntry(entryId);
  }

  /** Ältere Revision bewusst als NEUEN Entwurf übernehmen (Order §6); Historie bleibt. */
  async restoreRevision(
    actorId: string,
    entryId: string,
    input: { revisionId: string; baseRevisionId: string },
    now = new Date(),
  ): Promise<StaffCmsEntryDetail> {
    await this.db.transaction(async (tx) => {
      const entry = await this.lockEntry(tx, entryId);
      if (entry.draftRevisionId !== input.baseRevisionId) {
        throw new CmsError('CMS_DRAFT_CONFLICT', CMS_MESSAGES.DRAFT_CONFLICT);
      }
      const source = await this.revisionOfEntry(tx, entryId, input.revisionId);
      const shape = shapeOf(entry);
      // Erneut prüfen: Regeln (z. B. inzwischen gepflegte Abholadresse) gelten für jeden neuen Entwurf.
      const checked = parseEntryContent(shape, source.content);
      const meta = parseMeta(source);
      const mediaIds = await assertDraftRules(tx, shape, checked, meta);
      await this.appendRevision(tx, entry, {
        checked,
        meta,
        editorNote: source.editorNote,
        basedOnRevisionId: source.id,
        createdBy: actorId,
        mediaIds,
        now,
      });
    });
    return this.getEntry(entryId);
  }

  // ── Veröffentlichen ───────────────────────────────────────────────────────

  /**
   * Atomar veröffentlichen: nur der AKTUELLE Entwurf (`revisionId` = `draft_revision_id`,
   * sonst 409 `CMS_PUBLISH_STALE`), mit allen Prüfungen und Audit in derselben Transaktion.
   * `actorId` null ⇒ `cms:bootstrap --publish-demo` (Audit-Quelle `bootstrap`).
   */
  async publish(
    actorId: string | null,
    entryId: string,
    input: { revisionId: string },
    options: { source?: CmsPublishSource; now?: Date } = {},
  ): Promise<StaffCmsEntryDetail> {
    const now = options.now ?? new Date();
    const source = options.source ?? (actorId === null ? 'bootstrap' : 'staff');
    await this.db.transaction(async (tx) => {
      const entry = await this.lockEntry(tx, entryId);
      if (entry.draftRevisionId === null || entry.draftRevisionId !== input.revisionId) {
        throw new CmsError('CMS_PUBLISH_STALE', CMS_MESSAGES.PUBLISH_STALE);
      }
      if (entry.publishedRevisionId === input.revisionId) {
        throw new CmsError('CMS_ALREADY_PUBLISHED', CMS_MESSAGES.ALREADY_PUBLISHED);
      }
      const revision = await this.revisionOfEntry(tx, entryId, input.revisionId);
      const shape = shapeOf(entry);
      const checked = parseEntryContent(shape, revision.content);
      const meta = parseMeta(revision);
      assertPublishable(shape, checked, meta);
      await assertTextRules(tx, shape, checked, meta);
      if (checked.kind === 'site_settings') {
        await assertRecommendationRules(tx, checked.content);
      }
      await assertMediaExist(tx, checked);
      const previousRevisionId = entry.publishedRevisionId;
      await tx
        .update(cmsEntries)
        .set({
          publishedRevisionId: revision.id,
          publishedAt: now,
          publishedBy: actorId,
          version: entry.version + 1,
          updatedAt: now,
        })
        .where(eq(cmsEntries.id, entry.id));
      await recordSecurityEvent(tx, {
        type: 'cms.published',
        actorUserId: actorId,
        details: {
          entryId: entry.id,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          previousRevisionId,
          path: entry.path,
          source,
        },
      });
    });
    return this.getEntry(entryId);
  }

  /** Zurückziehen – nur regionale Seiten und sekundäre Angebote (Design §2.2). */
  async unpublish(
    actorId: string,
    entryId: string,
    now = new Date(),
  ): Promise<StaffCmsEntryDetail> {
    await this.db.transaction(async (tx) => {
      const entry = await this.lockEntry(tx, entryId);
      if (
        entry.kind !== 'page' ||
        !UNPUBLISHABLE_PAGE_TYPES.includes(entry.pageType as CmsPageTypeName)
      ) {
        throw new CmsError('CMS_UNPUBLISH_FORBIDDEN', CMS_MESSAGES.UNPUBLISH_FORBIDDEN);
      }
      if (entry.publishedRevisionId === null) {
        throw new CmsError('CMS_NOT_PUBLISHED', CMS_MESSAGES.NOT_PUBLISHED);
      }
      const revision = await this.revisionOfEntry(tx, entryId, entry.publishedRevisionId);
      await tx
        .update(cmsEntries)
        .set({
          publishedRevisionId: null,
          publishedAt: null,
          publishedBy: null,
          version: entry.version + 1,
          updatedAt: now,
        })
        .where(eq(cmsEntries.id, entry.id));
      await recordSecurityEvent(tx, {
        type: 'cms.unpublished',
        actorUserId: actorId,
        details: {
          entryId: entry.id,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          path: entry.path,
          source: 'staff',
        },
      });
    });
    return this.getEntry(entryId);
  }

  // ── Regionale Seite anlegen ───────────────────────────────────────────────

  /** Eigenständige Regionsseite als Entwurf (Revision 1 mit leerer Blockliste); keine Massenerzeugung. */
  async createRegionPage(
    actorId: string,
    input: { regionSlug: string; title: string },
    now = new Date(),
  ): Promise<StaffCmsEntryDetail> {
    const slug = input.regionSlug.trim().toLowerCase();
    if (
      slug.length < 2 ||
      slug.length > CMS_REGION_SLUG_MAX ||
      !CMS_REGION_SLUG_PATTERN.test(slug)
    ) {
      throw new RequestValidationError([
        {
          path: 'regionSlug',
          message: `Nur Kleinbuchstaben, Ziffern und Bindestriche (2–${CMS_REGION_SLUG_MAX} Zeichen), z. B. „ingelheim“.`,
        },
      ]);
    }
    const path = `${CMS_REGION_PATH_PREFIX}${slug}`;
    const shape: CmsEntryShape = { kind: 'page', pageType: 'region' };
    const checked = parseEntryContent(shape, { title: input.title, blocks: [] });
    const meta: CmsMetaInput = { metaTitle: null, metaDescription: null };
    const entryId = await this.db.transaction(async (tx) => {
      await assertDraftRules(tx, shape, checked, meta);
      const inserted = await tx
        .insert(cmsEntries)
        .values({ kind: 'page', pageType: 'region', path, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning();
      const entry = inserted[0];
      if (entry === undefined) throw new CmsError('CMS_PATH_TAKEN', CMS_MESSAGES.PATH_TAKEN);
      await this.appendRevision(tx, entry, {
        checked,
        meta,
        editorNote: null,
        basedOnRevisionId: null,
        createdBy: actorId,
        mediaIds: [],
        now,
      });
      return entry.id;
    });
    return this.getEntry(entryId);
  }

  // ── Vorschau-Zugang ───────────────────────────────────────────────────────

  /**
   * Kurzlebiger Vorschau-Zugang zu GENAU EINER Revision des Eintrags (Default: aktueller
   * Entwurf). Token nur als SHA-256 gespeichert; die URL trägt ihn im Fragment.
   */
  async createPreviewAccess(
    actorId: string,
    entryId: string,
    input: { revisionId?: string | undefined },
    now = new Date(),
  ): Promise<CmsPreviewAccessResult> {
    const baseUrl = this.options.publicWebBaseUrl;
    if (baseUrl === null || baseUrl === '') {
      throw new CmsError('CMS_PREVIEW_UNAVAILABLE', CMS_MESSAGES.PREVIEW_UNAVAILABLE);
    }
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + CMS_PREVIEW_TTL_MS);
    await this.db.transaction(async (tx) => {
      const entries = await tx.select().from(cmsEntries).where(eq(cmsEntries.id, entryId));
      const entry = entries[0];
      if (entry === undefined || entry.draftRevisionId === null) {
        throw new CmsError('NOT_FOUND', CMS_MESSAGES.NOT_FOUND);
      }
      const revisionId = input.revisionId ?? entry.draftRevisionId;
      // Revision eines ANDEREN Eintrags ⇒ 404 (zusätzlich zum zusammengesetzten FK).
      await this.revisionOfEntry(tx, entryId, revisionId);
      await tx
        .delete(cmsPreviewAccess)
        .where(
          lt(cmsPreviewAccess.expiresAt, new Date(now.getTime() - CMS_PREVIEW_CLEANUP_AFTER_MS)),
        );
      await tx.insert(cmsPreviewAccess).values({
        entryId,
        revisionId,
        accessTokenHash: sha256Hex(token),
        createdBy: actorId,
        createdAt: now,
        expiresAt,
      });
      await recordSecurityEvent(tx, {
        type: 'cms.preview_created',
        actorUserId: actorId,
        details: { entryId, revisionId },
      });
    });
    return { url: `${baseUrl}/vorschau#token=${token}`, expiresAt: expiresAt.toISOString() };
  }

  // ── intern ────────────────────────────────────────────────────────────────

  private async lockEntry(tx: DatabaseTransaction, entryId: string): Promise<CmsEntryRow> {
    const rows = await tx.select().from(cmsEntries).where(eq(cmsEntries.id, entryId)).for('update');
    const entry = rows[0];
    if (entry === undefined) throw new CmsError('NOT_FOUND', CMS_MESSAGES.NOT_FOUND);
    return entry;
  }

  private async revisionOfEntry(
    executor: DatabaseExecutor,
    entryId: string,
    revisionId: string,
  ): Promise<CmsRevisionRow> {
    const rows = await executor
      .select()
      .from(cmsRevisions)
      .where(and(eq(cmsRevisions.id, revisionId), eq(cmsRevisions.entryId, entryId)));
    const revision = rows[0];
    if (revision === undefined) throw new CmsError('NOT_FOUND', CMS_MESSAGES.REVISION_NOT_FOUND);
    return revision;
  }

  /**
   * Neue Revision anhängen (Nummer = max + 1; der Eintrag ist gesperrt bzw. frisch angelegt),
   * Medienbindung `cms_revision_media` befüllen, Entwurfszeiger umsetzen, `version += 1`.
   */
  private async appendRevision(
    tx: DatabaseTransaction,
    entry: CmsEntryRow,
    input: {
      checked: CmsCheckedContent;
      meta: CmsMetaInput;
      editorNote: string | null;
      basedOnRevisionId: string | null;
      createdBy: string | null;
      mediaIds: readonly string[];
      now: Date;
    },
  ): Promise<CmsRevisionRow> {
    const numbers = await tx
      .select({ value: max(cmsRevisions.revisionNumber) })
      .from(cmsRevisions)
      .where(eq(cmsRevisions.entryId, entry.id));
    const revisionNumber = (numbers[0]?.value ?? 0) + 1;
    const inserted = await tx
      .insert(cmsRevisions)
      .values({
        entryId: entry.id,
        revisionNumber,
        content: input.checked.content,
        metaTitle: input.meta.metaTitle,
        metaDescription: input.meta.metaDescription,
        editorNote: input.editorNote,
        basedOnRevisionId: input.basedOnRevisionId,
        createdBy: input.createdBy,
        createdAt: input.now,
      })
      .returning();
    const revision = inserted[0]!;
    if (input.mediaIds.length > 0) {
      await tx
        .insert(cmsRevisionMedia)
        .values(input.mediaIds.map((mediaId) => ({ revisionId: revision.id, mediaId })));
    }
    await tx
      .update(cmsEntries)
      .set({ draftRevisionId: revision.id, version: entry.version + 1, updatedAt: input.now })
      .where(eq(cmsEntries.id, entry.id));
    return revision;
  }

  /**
   * Für `cms:bootstrap`: Eintrag mit Revision 1 (created_by NULL) als ENTWURF anlegen – nur
   * wenn er fehlt. Ein vorhandener Eintrag bleibt unberührt (auch wenn leer); dieselben
   * Prüfregeln wie beim Speichern eines Entwurfs.
   */
  async createEntryIfMissing(
    target: { kind: 'site_settings' } | { kind: 'page'; pageType: CmsPageTypeName; path: string },
    input: {
      content: unknown;
      metaTitle?: string | null | undefined;
      metaDescription?: string | null | undefined;
      editorNote?: string | null | undefined;
    },
    now = new Date(),
  ): Promise<{ created: boolean; entryId: string }> {
    const shape: CmsEntryShape =
      target.kind === 'site_settings'
        ? { kind: 'site_settings', pageType: null }
        : { kind: 'page', pageType: target.pageType };
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: cmsEntries.id })
        .from(cmsEntries)
        .where(
          target.kind === 'site_settings'
            ? eq(cmsEntries.kind, 'site_settings')
            : eq(cmsEntries.path, target.path),
        );
      if (existing[0] !== undefined) return { created: false, entryId: existing[0].id };
      const checked = parseEntryContent(shape, input.content);
      const meta = parseMeta(input);
      const editorNote = parseEditorNote(input.editorNote);
      const mediaIds = await assertDraftRules(tx, shape, checked, meta);
      const inserted = await tx
        .insert(cmsEntries)
        .values(
          target.kind === 'site_settings'
            ? { kind: 'site_settings', createdAt: now, updatedAt: now }
            : {
                kind: 'page',
                pageType: target.pageType,
                path: target.path,
                createdAt: now,
                updatedAt: now,
              },
        )
        .onConflictDoNothing()
        .returning();
      const entry = inserted[0];
      if (entry === undefined) {
        // Paralleler Bootstrap war schneller – vorhandenen Eintrag unberührt lassen.
        const raced = await tx
          .select({ id: cmsEntries.id })
          .from(cmsEntries)
          .where(
            target.kind === 'site_settings'
              ? eq(cmsEntries.kind, 'site_settings')
              : eq(cmsEntries.path, target.path),
          );
        return { created: false, entryId: raced[0]?.id ?? '' };
      }
      await this.appendRevision(tx, entry, {
        checked,
        meta,
        editorNote,
        basedOnRevisionId: null,
        createdBy: null,
        mediaIds,
        now,
      });
      return { created: true, entryId: entry.id };
    });
  }
}
