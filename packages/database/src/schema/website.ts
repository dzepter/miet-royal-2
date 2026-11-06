import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { inquiries } from './commerce.ts';
import { customers, processes } from './crm.ts';
import { staffUsers } from './staff-auth.ts';

/**
 * Phase 16 (Website + CMS + Konfigurator): schlankes internes CMS und die
 * Metadaten öffentlicher Website-Anfragen.
 *
 * CMS-Grundsätze (Order §6):
 * - stabile Einträge (`cms_entries`) mit Zeigern auf den aktuellen Entwurf und
 *   die aktuell veröffentlichte Revision;
 * - Revisionen (`cms_revisions`) sind IMMUTABLE (DB-Trigger verbietet UPDATE);
 *   jede Entwurfsänderung erzeugt eine neue Revision, die Historie bleibt;
 * - Veröffentlichen = atomares Umsetzen von `published_revision_id` auf die
 *   geprüfte Entwurfsrevision; ein Entwurf beeinflusst die öffentliche Website nie.
 * - Inhalte sind strukturierte, streng validierte Blöcke (packages/validation
 *   `cms.ts`) – kein HTML, kein Script, keine Preise (Preise kommen nur aus
 *   products/product_prices).
 *
 * Demo: CMS-Tabellen gehören NICHT zur Business-Reset-Löschliste – Redaktions-
 * inhalt überlebt den Demo-Reset; `public_inquiry_submissions` dagegen schon.
 */

/** Eintragsart: genau ein `site_settings`-Eintrag (Singleton) und beliebige Seiten. */
export const cmsEntryKind = pgEnum('cms_entry_kind', ['site_settings', 'page']);

/** Seitentyp (Order §6). Der öffentliche Pfad hängt fest am Typ (Service-Regel). */
export const cmsPageType = pgEnum('cms_page_type', [
  'home',
  'slush',
  'process',
  'faq',
  'about',
  'contact',
  'legal',
  'region',
  'secondary_offer',
]);

/**
 * Kundenzuordnung einer Website-Anfrage (Order §16):
 * - `portal_session`: gültige Portal-Session ⇒ genau dieser Kunde;
 * - `email_unique`: anonym, genau EIN aktiver Kunde mit der normalisierten E-Mail;
 * - `new_customer`: kein Treffer ⇒ neuer Kunde;
 * - `new_customer_email_ambiguous`: mehrere aktive Kunden mit derselben E-Mail ⇒
 *   neuer Kunde mit interner Dublettenwarnung (nichts erraten, nichts zusammenführen).
 */
export const publicInquiryCustomerMatch = pgEnum('public_inquiry_customer_match', [
  'portal_session',
  'email_unique',
  'new_customer',
  'new_customer_email_ambiguous',
]);

export const cmsEntries = pgTable(
  'cms_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: cmsEntryKind('kind').notNull(),
    pageType: cmsPageType('page_type'),
    /** Öffentlicher Pfad (z. B. „/“, „/faq“, „/slushmaschine-mieten/mainz“); NULL nur bei site_settings. */
    path: text('path'),
    /** Aktueller Entwurf (immer gesetzt, sobald der Eintrag eine Revision hat). */
    draftRevisionId: uuid('draft_revision_id').references((): AnyPgColumn => cmsRevisions.id),
    /** Aktuell veröffentlichte Revision; NULL = nie bzw. nicht (mehr) veröffentlicht. */
    publishedRevisionId: uuid('published_revision_id').references(
      (): AnyPgColumn => cmsRevisions.id,
    ),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    /** Optimistische Sperre für Entwurfs-/Veröffentlichungsaktionen. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cms_entries_path_unique')
      .on(table.path)
      .where(sql`${table.path} IS NOT NULL`),
    uniqueIndex('cms_entries_site_settings_singleton')
      .on(table.kind)
      .where(sql`${table.kind} = 'site_settings'`),
    check(
      'cms_entries_kind_check',
      sql`(${table.kind} = 'site_settings' AND ${table.pageType} IS NULL AND ${table.path} IS NULL) OR (${table.kind} = 'page' AND ${table.pageType} IS NOT NULL AND ${table.path} IS NOT NULL)`,
    ),
    check(
      'cms_entries_path_format',
      sql`${table.path} IS NULL OR ${table.path} ~ '^/([a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*)?$'`,
    ),
    check(
      'cms_entries_published_consistency',
      sql`(${table.publishedRevisionId} IS NULL) = (${table.publishedAt} IS NULL)`,
    ),
  ],
);

/** Immutable Revision eines Eintrags (DB-Trigger `cms_revisions_immutable` verbietet UPDATE). */
export const cmsRevisions = pgTable(
  'cms_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => cmsEntries.id, { onDelete: 'cascade' }),
    /** Laufende Nummer je Eintrag (1, 2, …) – für Anzeige und Audit. */
    revisionNumber: integer('revision_number').notNull(),
    /** Validierter Inhalt (packages/validation `cms.ts`): Seiteninhalt bzw. Website-Einstellungen. */
    content: jsonb('content').notNull(),
    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),
    /** Interne Redaktionsnotiz (nie öffentlich), z. B. „vor Live rechtlich prüfen“. */
    editorNote: text('editor_note'),
    /** Bewusst aus einer älteren Revision übernommen (Order §6). */
    basedOnRevisionId: uuid('based_on_revision_id').references((): AnyPgColumn => cmsRevisions.id),
    /**
     * NULL = System (z. B. `pnpm cms:bootstrap`). Bewusst ohne ON DELETE-Aktion: Revisionen
     * sind historisch und immutable (ein SET NULL wäre ein vom Trigger verbotenes UPDATE).
     */
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cms_revisions_entry_number_unique').on(table.entryId, table.revisionNumber),
    check('cms_revisions_number_positive', sql`${table.revisionNumber} >= 1`),
  ],
);

/**
 * CMS-Medium (Order §8): nur verarbeitete Varianten werden gespeichert (Decode +
 * Re-Encoding ⇒ Metadaten entfernt, kein Original mit EXIF). Öffentlich nur über
 * die opake `id`, nie über einen Storage-Key.
 */
export const cmsMedia = pgTable(
  'cms_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Interne Bezeichnung für die Medienliste (kein Dateiname). */
    label: text('label').notNull(),
    /** Format des hochgeladenen Originals (nur zur Information; gespeichert werden nur Varianten). */
    sourceMimeType: text('source_mime_type').notNull(),
    /** Abmessungen nach Ausrichtung (EXIF-Orientation angewendet). */
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** SHA-256 des hochgeladenen Originals (Nachvollziehbarkeit, keine Inhalte). */
    sourceSha256: text('source_sha256').notNull(),
    /** Vorschlag für Alt-Text in der Medienliste; maßgeblich ist der Alt-Text am Einsatzort (Block). */
    defaultAlt: text('default_alt'),
    uploadedBy: uuid('uploaded_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'cms_media_source_mime_check',
      sql`${table.sourceMimeType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check('cms_media_dimensions_check', sql`${table.width} > 0 AND ${table.height} > 0`),
  ],
);

/** Ausgelieferte Variante eines Mediums (WebP, je Zielbreite). */
export const cmsMediaVariants = pgTable(
  'cms_media_variants',
  {
    mediaId: uuid('media_id')
      .notNull()
      .references(() => cmsMedia.id, { onDelete: 'cascade' }),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** Interner Storage-Key – NIE öffentlich ausgeben. */
    storageKey: text('storage_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.mediaId, table.width] }),
    check('cms_media_variants_mime_check', sql`${table.mimeType} = 'image/webp'`),
  ],
);

/** Welche Medien eine Revision referenziert (für „nur veröffentlichte Medien sind öffentlich“). */
export const cmsRevisionMedia = pgTable(
  'cms_revision_media',
  {
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => cmsRevisions.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => cmsMedia.id),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.mediaId] }),
    index('cms_revision_media_media_idx').on(table.mediaId),
  ],
);

/**
 * Vorschauzugang (Order §9): kurzer Zugang zu GENAU EINER Entwurfsrevision.
 * `access_token_hash` = SHA-256 des Fragment-Tokens (einmalig einlösbar);
 * beim Einlösen entsteht ein Sitzungstoken (HttpOnly-Cookie), gespeichert nur als
 * `session_token_hash`. Ablauf absolut (`expires_at`, ca. 30 min nach Erzeugung).
 */
export const cmsPreviewAccess = pgTable(
  'cms_preview_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => cmsEntries.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => cmsRevisions.id, { onDelete: 'cascade' }),
    accessTokenHash: text('access_token_hash').notNull().unique(),
    sessionTokenHash: text('session_token_hash').unique(),
    createdBy: uuid('created_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    index('cms_preview_access_expires_idx').on(table.expiresAt),
    check('cms_preview_access_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'cms_preview_access_session_check',
      sql`(${table.sessionTokenHash} IS NULL) = (${table.consumedAt} IS NULL)`,
    ),
  ],
);

/**
 * Metadaten einer öffentlichen Website-Anfrage (Order §15–§17). Eine Zeile je
 * erfolgreich angelegtem Vorgang; `client_mutation_id` macht Retry/Doppelklick
 * idempotent. Der Kontakt-Snapshot ist unveränderlich (Staff sieht Abweichungen
 * zum CRM), der Datenschutz-Nachweis verweist auf die damals veröffentlichte
 * Revision der Datenschutzhinweise (nicht der Volltext).
 */
export const publicInquirySubmissions = pgTable(
  'public_inquiry_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientMutationId: uuid('client_mutation_id').notNull().unique(),
    /** SHA-256 der kanonischen Anfrage – gleicher Schlüssel mit anderem Inhalt ⇒ 409. */
    payloadHash: text('payload_hash').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    processId: uuid('process_id')
      .notNull()
      .unique()
      .references(() => processes.id),
    inquiryId: uuid('inquiry_id')
      .notNull()
      .unique()
      .references(() => inquiries.id),
    customerMatch: publicInquiryCustomerMatch('customer_match').notNull(),
    /** Tatsächlich abgesendete Kontaktangaben (unveränderlich). */
    contactSnapshot: jsonb('contact_snapshot').notNull(),
    privacyRevisionId: uuid('privacy_revision_id')
      .notNull()
      .references(() => cmsRevisions.id),
    privacyAcknowledgedAt: timestamp('privacy_acknowledged_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('public_inquiry_submissions_customer_idx').on(table.customerId)],
);

export type CmsEntryRow = typeof cmsEntries.$inferSelect;
export type CmsRevisionRow = typeof cmsRevisions.$inferSelect;
export type CmsMediaRow = typeof cmsMedia.$inferSelect;
export type CmsMediaVariantRow = typeof cmsMediaVariants.$inferSelect;
export type CmsPreviewAccessRow = typeof cmsPreviewAccess.$inferSelect;
export type PublicInquirySubmissionRow = typeof publicInquirySubmissions.$inferSelect;
export type CmsEntryKind = (typeof cmsEntryKind.enumValues)[number];
export type CmsPageType = (typeof cmsPageType.enumValues)[number];
export type PublicInquiryCustomerMatch = (typeof publicInquiryCustomerMatch.enumValues)[number];
