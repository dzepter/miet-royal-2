'use client';

import {
  CMS_BLOCK_TYPES,
  CMS_REGION_PATH_PREFIX,
  CMS_REGION_SLUG_MAX,
  CMS_REGION_SLUG_PATTERN,
  type CmsBlock,
  type CmsBlockType,
  type CmsPageTypeName,
} from '@mietroyal/validation/cms';
import type { ApiIssue } from './api';

/**
 * Phase 16 (STAFF): Typen und Darstellungshilfen des Website-CMS (Design §2.2/§6).
 *
 * Die Staff-App zeigt nur an, was die API liefert: Inhaltsschema, Prüfregeln und
 * Preise kommen aus `@mietroyal/validation/cms` bzw. vom Server. Clientseitige
 * Prüfungen sind reine UX – der Server prüft jede Aktion erneut (Rechte, Schema,
 * Preistext, exakte Abholadresse, Medien, Empfehlungsregeln).
 */

// ── DTOs (Verträge laut Design §2.2 / §3.1 / §3.4) ─────────────────────────

export type CmsEntryStatus = 'never_published' | 'published' | 'published_with_draft_changes';

export interface CmsStaffUserRef {
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
  createdBy: CmsStaffUserRef | null;
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

export interface StaffCmsHistoryItem {
  revisionId: string;
  revisionNumber: number;
  createdAt: string;
  createdBy: CmsStaffUserRef | null;
  basedOnRevisionNumber: number | null;
  isDraft: boolean;
  isPublished: boolean;
}

export interface StaffCmsEntryDetail extends StaffCmsEntrySummary {
  version: number;
  draft: StaffCmsRevision;
  published: {
    revisionId: string;
    revisionNumber: number;
    publishedAt: string;
    publishedBy: CmsStaffUserRef | null;
  } | null;
  history: StaffCmsHistoryItem[];
  canUnpublish: boolean;
}

export interface StaffCmsMedia {
  id: string;
  label: string;
  width: number;
  height: number;
  defaultAlt: string | null;
  createdAt: string;
  usedInPublished: boolean;
  variantWidths: number[];
}

export interface CmsPreviewAccess {
  url: string;
  expiresAt: string;
}

/** Öffentliche Katalog-Projektion (`GET /staff/cms/catalog`, gleich `/public/configurator/catalog`). */
export interface CmsCatalogProduct {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  priceCents: number;
  billingMode: 'fixed' | 'commission';
  unitLabel: string;
}

export interface CmsCatalogMachine extends CmsCatalogProduct {
  containerCount: number;
  containerVolumeLiters: number;
}

export interface CmsCatalog {
  asOf: string;
  machines: CmsCatalogMachine[];
  syrups: CmsCatalogProduct[];
  accessories: CmsCatalogProduct[];
  canister: (CmsCatalogProduct & { maxPerContainer: number }) | null;
  included: {
    freeSyrupLitersPerContainer: number;
    cupsPerProcess: number;
    strawsPerProcess: number;
  };
  pickupArea: string;
  largeEventGuestThreshold: number;
  priceNote: string;
}

export type WebsiteCustomerMatch =
  'portal_session' | 'email_unique' | 'new_customer' | 'new_customer_email_ambiguous';

export type WebsiteContactSnapshot =
  | {
      type: 'private';
      firstName: string;
      lastName: string;
      email: string;
      phone: string | null;
    }
  | {
      type: 'organization';
      organizationName: string;
      contactPerson: string;
      email: string;
      phone: string | null;
    };

/** `GET /staff/processes/:id/website-submission` (Design §3.4); 404 ⇒ keine Website-Anfrage. */
export interface WebsiteSubmission {
  submittedAt: string;
  customerMatch: WebsiteCustomerMatch;
  duplicateWarning: boolean;
  contactSnapshot: WebsiteContactSnapshot;
  differences: string[];
  privacy: { acknowledgedAt: string; revisionNumber: number };
}

// ── Bezeichnungen (keine rohen Enums in der Oberfläche, UX_RULES) ──────────

/**
 * Status-Texte. „Nicht veröffentlicht“ statt „Nie veröffentlicht“: Die API meldet
 * `never_published` auch für bewusst zurückgezogene Seiten.
 */
export const CMS_STATUS_LABELS: Record<CmsEntryStatus, string> = {
  published: 'Veröffentlicht',
  published_with_draft_changes: 'Entwurf mit Änderungen',
  never_published: 'Nicht veröffentlicht',
};

export const CMS_PAGE_TYPE_LABELS: Record<CmsPageTypeName, string> = {
  home: 'Startseite',
  slush: 'Slush',
  process: 'Ablauf',
  faq: 'FAQ',
  about: 'Über uns',
  contact: 'Kontakt',
  legal: 'Rechtliches',
  region: 'Regionale Seite',
  secondary_offer: 'Sekundäres Angebot',
};

export const CMS_BLOCK_TYPE_LABELS: Record<CmsBlockType, string> = {
  hero: 'Kopfbereich (Hero)',
  text: 'Text',
  features: 'Vorteile',
  steps: 'Ablauf-Schritte',
  product_grid: 'Produkte mit Preisen (automatisch)',
  included_items: 'Inklusivleistungen & Zubehör (automatisch)',
  image: 'Bild',
  gallery: 'Bildergalerie',
  faq: 'Häufige Fragen',
  reviews: 'Bewertungen',
  service_areas: 'Einsatzgebiete',
  secondary_offers: 'Weitere Angebote',
  contact_details: 'Kontaktangaben',
  cta: 'Handlungsaufforderung (Buttons)',
};

/** Kurze Erklärung für Blöcke, deren Inhalt NICHT im CMS gepflegt wird. */
export const CMS_BLOCK_TYPE_HINTS: Partial<Record<CmsBlockType, string>> = {
  hero: 'Nur als erster Block erlaubt. Die Überschrift ist dann die Hauptüberschrift der Seite.',
  product_grid:
    'Produkte und Preise kommen automatisch aus „Produkte & Preise“ – nie aus dem CMS. Ohne Auswahl erscheinen die Slush-Maschinen. Produkte ohne aktuellen Preis werden nicht angezeigt.',
  included_items:
    'Inklusivleistungen (Gratis-Sirup je Behälter, Becher, Strohhalme) sowie Sirup-, Zubehör- und Kanisterpreise kommen automatisch aus den Produktdaten.',
  reviews:
    'Erscheint nur, wenn ein Bewertungsanbieter eingerichtet ist. Bewertungen werden erst auf Klick der Besucher geladen.',
  secondary_offers: 'Verlinkt nur bewusst veröffentlichte Seiten für weitere Angebote.',
  contact_details: 'Telefon und E-Mail kommen aus den veröffentlichten Website-Einstellungen.',
  service_areas:
    'Nur Ortsnamen. Regionale Seiten werden nur verlinkt, wenn sie veröffentlicht sind.',
};

export const CUSTOMER_MATCH_LABELS: Record<WebsiteCustomerMatch, string> = {
  portal_session: 'Kunde war im Kundenbereich angemeldet – diesem Kunden zugeordnet.',
  email_unique:
    'Bestehendem Kunden über die eindeutige E-Mail-Adresse zugeordnet. Kundenstamm wurde nicht verändert.',
  new_customer: 'Neuer Kunde aus den Website-Angaben angelegt.',
  new_customer_email_ambiguous:
    'Neuer Kunde angelegt, weil mehrere bestehende Kunden diese E-Mail-Adresse haben.',
};

export const CONTACT_FIELD_LABELS: Record<string, string> = {
  type: 'Kundenart',
  firstName: 'Vorname',
  lastName: 'Nachname',
  organizationName: 'Organisation',
  contactPerson: 'Ansprechpartner',
  email: 'E-Mail',
  phone: 'Telefon',
};

// ── Übersicht: Gruppen ─────────────────────────────────────────────────────

export type CmsGroupKey = 'settings' | 'main' | 'region' | 'secondary' | 'legal';

export const CMS_GROUPS: ReadonlyArray<{ key: CmsGroupKey; title: string }> = [
  { key: 'settings', title: 'Einstellungen' },
  { key: 'main', title: 'Hauptseiten' },
  { key: 'region', title: 'Regionale Seiten' },
  { key: 'secondary', title: 'Sekundäre Angebote' },
  { key: 'legal', title: 'Rechtliches' },
];

const MAIN_PAGE_ORDER: readonly CmsPageTypeName[] = [
  'home',
  'slush',
  'process',
  'faq',
  'about',
  'contact',
];

export function cmsGroupOf(entry: StaffCmsEntrySummary): CmsGroupKey {
  if (entry.kind === 'site_settings') return 'settings';
  switch (entry.pageType) {
    case 'region':
      return 'region';
    case 'secondary_offer':
      return 'secondary';
    case 'legal':
      return 'legal';
    default:
      return 'main';
  }
}

/** Einträge je Gruppe; Hauptseiten in Navigationsreihenfolge, sonst nach Pfad. */
export function groupCmsEntries(
  entries: readonly StaffCmsEntrySummary[],
): Record<CmsGroupKey, StaffCmsEntrySummary[]> {
  const groups: Record<CmsGroupKey, StaffCmsEntrySummary[]> = {
    settings: [],
    main: [],
    region: [],
    secondary: [],
    legal: [],
  };
  for (const entry of entries) groups[cmsGroupOf(entry)].push(entry);
  const rank = (entry: StaffCmsEntrySummary) => {
    const index = entry.pageType === null ? -1 : MAIN_PAGE_ORDER.indexOf(entry.pageType);
    return index === -1 ? MAIN_PAGE_ORDER.length : index;
  };
  groups.main.sort((a, b) => rank(a) - rank(b) || (a.path ?? '').localeCompare(b.path ?? ''));
  for (const key of ['region', 'secondary', 'legal'] as const) {
    groups[key].sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
  }
  return groups;
}

// ── Blöcke: Anlegen und Bereinigen ─────────────────────────────────────────

/** Leerer Block eines Typs (Pflichtfelder leer – die Prüfung meldet sie beim Speichern). */
export function newCmsBlock(type: CmsBlockType): CmsBlock {
  const emptyItem = { title: '', text: '' };
  switch (type) {
    case 'hero':
      return { type, heading: '' };
    case 'text':
      return { type, body: '' };
    case 'features':
    case 'steps':
      return { type, items: [{ ...emptyItem }] };
    case 'product_grid':
    case 'included_items':
    case 'reviews':
    case 'secondary_offers':
    case 'contact_details':
      return { type };
    case 'image':
      return { type, image: { mediaId: '', alt: '', decorative: false } };
    case 'gallery':
      return { type, images: [{ mediaId: '', alt: '', decorative: false }] };
    case 'faq':
      return { type, items: [{ question: '', answer: '' }] };
    case 'service_areas':
      return { type, areas: [''] };
    case 'cta':
      return { type, heading: '', primary: { label: '', href: '' } };
  }
}

/** Blocktypen, die für einen Seitentyp angeboten werden (Rechtstexte: nur Text). */
export function allowedBlockTypes(pageType: CmsPageTypeName | null): readonly CmsBlockType[] {
  return pageType === 'legal' ? ['text'] : CMS_BLOCK_TYPES;
}

const OPTIONAL_TEXT_KEYS: Record<CmsBlockType, readonly string[]> = {
  hero: ['lead'],
  text: ['heading'],
  features: ['heading', 'intro'],
  steps: ['heading', 'intro'],
  product_grid: ['heading', 'intro'],
  included_items: ['heading', 'intro'],
  image: ['caption'],
  gallery: ['heading'],
  faq: ['heading'],
  reviews: ['heading', 'intro'],
  service_areas: ['heading', 'intro'],
  secondary_offers: ['heading', 'intro'],
  contact_details: ['heading', 'intro'],
  cta: ['text'],
};
const OPTIONAL_CTA_KEYS: Partial<Record<CmsBlockType, readonly string[]>> = {
  hero: ['primaryCta', 'secondaryCta'],
  cta: ['secondary'],
};

function isBlankCta(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  const { label, href } = value as { label?: unknown; href?: unknown };
  return (
    (typeof label !== 'string' || label.trim() === '') &&
    (typeof href !== 'string' || href.trim() === '')
  );
}

/**
 * Entfernt leere OPTIONALE Felder (leere Texte, leere Buttons, fehlendes optionales Bild,
 * leere Produktauswahl), damit das Schema sie als „nicht gesetzt“ liest. Pflichtfelder
 * bleiben unverändert stehen – das Schema meldet sie dann verständlich.
 */
export function cleanCmsBlock(block: CmsBlock): Record<string, unknown> {
  const out: Record<string, unknown> = { ...block };
  for (const key of OPTIONAL_TEXT_KEYS[block.type]) {
    const value = out[key];
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) delete out[key];
  }
  for (const key of OPTIONAL_CTA_KEYS[block.type] ?? []) {
    if (isBlankCta(out[key])) delete out[key];
  }
  if (block.type === 'hero' && (block.image === undefined || block.image.mediaId === '')) {
    delete out.image;
  }
  if (block.type === 'product_grid' && (block.productSlugs ?? []).length === 0) {
    delete out.productSlugs;
  }
  return out;
}

// ── Prüfmeldungen ──────────────────────────────────────────────────────────

/** Strukturelle Sicht auf eine Zod-Meldung (ohne Abhängigkeit von Zod-Typen). */
export interface CmsSchemaIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  minimum?: unknown;
  maximum?: unknown;
  origin?: unknown;
  format?: unknown;
}

const DEFAULT_ZOD_MESSAGE = /^(Invalid|Too (small|big)|Expected|Unrecognized)/;

/** Deutsche Meldung: eigene (deutsche) Schemameldungen bleiben, Zod-Standardtexte werden ersetzt. */
export function germanIssueMessage(issue: CmsSchemaIssue): string {
  if (issue.code === 'custom' || !DEFAULT_ZOD_MESSAGE.test(issue.message)) return issue.message;
  const last = issue.path[issue.path.length - 1];
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'array') return `Mindestens ${String(issue.minimum)} Einträge.`;
      if (issue.origin === 'string') return 'Bitte ausfüllen.';
      return `Mindestens ${String(issue.minimum)}.`;
    case 'too_big':
      if (issue.origin === 'array') return `Höchstens ${String(issue.maximum)} Einträge.`;
      if (issue.origin === 'string') return `Höchstens ${String(issue.maximum)} Zeichen.`;
      return `Höchstens ${String(issue.maximum)}.`;
    case 'invalid_format':
      if (last === 'mediaId' || issue.format === 'uuid') return 'Bitte ein Bild auswählen.';
      if (issue.format === 'url') return 'Bitte eine vollständige https-Adresse angeben.';
      return 'Ungültiges Format.';
    case 'invalid_type':
      if (last === 'guestMin' || last === 'guestMax') return 'Bitte eine ganze Zahl angeben.';
      return 'Bitte ausfüllen.';
    default:
      return 'Ungültige Angabe.';
  }
}

export function issuesFromSchema(
  issues: readonly CmsSchemaIssue[],
  prefix: readonly PropertyKey[] = [],
): ApiIssue[] {
  return issues.map((issue) => ({
    path: [...prefix, ...issue.path].map(String).join('.'),
    message: germanIssueMessage(issue),
  }));
}

/** Server-Pfade („body.content.blocks.2.body“) auf Editor-Pfade („blocks.2.body“) kürzen. */
export function normalizeIssuePath(path: string): string {
  let out = path;
  if (out.startsWith('body.')) out = out.slice('body.'.length);
  if (out === 'content') return '';
  if (out.startsWith('content.')) out = out.slice('content.'.length);
  return out;
}

const PATH_LABELS: Record<string, string> = {
  title: 'Titel',
  blocks: 'Blöcke',
  heading: 'Überschrift',
  lead: 'Einleitung',
  intro: 'Einleitung',
  body: 'Text',
  text: 'Text',
  items: 'Eintrag',
  question: 'Frage',
  answer: 'Antwort',
  areas: 'Ort',
  images: 'Bild',
  image: 'Bild',
  alt: 'Alt-Text',
  mediaId: 'Bildauswahl',
  decorative: 'dekorativ',
  caption: 'Bildunterschrift',
  primaryCta: 'Haupt-Button',
  secondaryCta: 'Zweiter Button',
  primary: 'Haupt-Button',
  secondary: 'Zweiter Button',
  label: 'Beschriftung',
  href: 'Link',
  productSlugs: 'Produktauswahl',
  type: 'Blocktyp',
  metaTitle: 'Meta-Titel',
  metaDescription: 'Meta-Beschreibung',
  editorNote: 'Redaktionsnotiz',
  businessName: 'Firmenname',
  tagline: 'Kurzbeschreibung',
  contact: 'Kontakt',
  phone: 'Telefon',
  email: 'E-Mail',
  instagramUrl: 'Instagram-Link',
  logo: 'Logo',
  footerNote: 'Hinweis in der Fußzeile',
  recommendationRules: 'Empfehlungsregel',
  guestMin: 'Gäste ab',
  guestMax: 'Gäste bis',
  machineProductSlug: 'Maschine',
};

/** Lesbare Feldbeschreibung eines Editor-Pfads, z. B. „Block 3 (Vorteile) › Eintrag 1 › Titel“. */
export function describeIssuePath(path: string, blocks: readonly CmsBlock[] = []): string {
  if (path === '') return 'Inhalt';
  const parts = path.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === 'blocks' && /^\d+$/.test(parts[i + 1] ?? '')) {
      const index = Number(parts[i + 1]);
      const block = blocks[index];
      out.push(
        block === undefined
          ? `Block ${index + 1}`
          : `Block ${index + 1} (${CMS_BLOCK_TYPE_LABELS[block.type]})`,
      );
      i += 1;
      continue;
    }
    if (/^\d+$/.test(part)) {
      out.push(String(Number(part) + 1));
      continue;
    }
    const label = PATH_LABELS[part] ?? part;
    const next = parts[i + 1];
    if (next !== undefined && /^\d+$/.test(next)) {
      // „Eintrag 1“ statt „Eintrag › 1“
      out.push(`${label} ${Number(next) + 1}`);
      i += 1;
      continue;
    }
    out.push(label);
  }
  return out.join(' › ');
}

/** Index des Blocks, auf den sich ein Editor-Pfad bezieht (sonst null). */
export function blockIndexOfPath(path: string): number | null {
  const match = /^blocks\.(\d+)(\.|$)/.exec(path);
  return match === null ? null : Number(match[1]);
}

// ── Medien ─────────────────────────────────────────────────────────────────

/** Gleiche Grenzen wie die API (Design §2.3): JPEG/PNG/WebP, roh höchstens 6 MiB. */
export const CMS_MEDIA_MAX_BYTES = 6 * 1024 * 1024;
export const CMS_MEDIA_ACCEPT = 'image/jpeg,image/png,image/webp';
export const CMS_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
export const CMS_MEDIA_LABEL_MAX = 120;
export const CMS_MEDIA_ALT_MAX = 200;
export const CMS_EDITOR_NOTE_MAX = 2000;
export const CMS_META_TITLE_MAX = 70;
export const CMS_META_DESCRIPTION_MAX = 170;

/** Staff-Vorschau einer Variante (Sitzungs-Cookie, `private, no-store`) – nie der Storage-Key. */
export function cmsStaffMediaUrl(media: Pick<StaffCmsMedia, 'id' | 'variantWidths'>): string {
  const width = [...media.variantWidths].sort((a, b) => a - b)[0];
  return `/api/staff/cms/media/${media.id}/${width ?? 480}`;
}

// ── Regionale Seiten ───────────────────────────────────────────────────────

/** Vorschlag für den Adressteil aus dem Ortsnamen („Bad Kreuznach“ ⇒ „bad-kreuznach“). */
export function suggestRegionSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CMS_REGION_SLUG_MAX)
    .replace(/-+$/g, '');
}

export function isValidRegionSlug(slug: string): boolean {
  return (
    slug.length >= 2 && slug.length <= CMS_REGION_SLUG_MAX && CMS_REGION_SLUG_PATTERN.test(slug)
  );
}

export function regionPathOf(slug: string): string {
  return `${CMS_REGION_PATH_PREFIX}${slug}`;
}

// ── Phase 17: SEO-Hinweise (Design D12, Auftrag §11/§24) ───────────────────

/**
 * `GET /staff/cms/seo-check` (Recht cms.edit ODER cms.publish, `no-store`). Reine Hinweise
 * für die Redaktion – nie eine Sperre, kein Score. Die Meldungen kommen fertig auf Deutsch
 * vom Server; der Staff ordnet sie nur Einträgen zu und zeigt `message`.
 */
export type SeoWarningScope = 'draft' | 'published' | 'catalog';

export type SeoWarningField =
  'metaTitle' | 'metaDescription' | 'content' | 'links' | 'description' | 'name';

/** Bekannte Codes (Design D12). Die Oberfläche zeigt stets `message` – auch bei unbekanntem Code. */
export type SeoWarningCode =
  | 'META_TITLE_MISSING'
  | 'META_TITLE_SHORT'
  | 'META_TITLE_LONG'
  | 'META_DESCRIPTION_MISSING'
  | 'META_DESCRIPTION_SHORT'
  | 'META_DESCRIPTION_LONG'
  | 'META_TITLE_DUPLICATE'
  | 'META_DESCRIPTION_DUPLICATE'
  | 'PAGE_EMPTY'
  | 'BROKEN_INTERNAL_LINK'
  | 'REGION_NEAR_DUPLICATE'
  | 'PRODUCT_DESCRIPTION_PRICE_HIDDEN'
  | 'PRODUCT_NAME_PRICE_HIDDEN';

export interface SeoWarning {
  /** `SeoWarningCode` oder ein künftiger Code – nur als `data-code` ausgegeben, nie interpretiert. */
  code: string;
  scope: SeoWarningScope;
  entryId: string | null;
  path: string | null;
  field: SeoWarningField | null;
  message: string;
}

export interface SeoCheckResponse {
  checkedAt: string;
  warnings: SeoWarning[];
}

/** Scope immer als Text (nie roher Enum, UX_RULES). */
export const SEO_SCOPE_LABELS: Record<SeoWarningScope, string> = {
  published: 'Veröffentlicht',
  draft: 'Entwurf',
  catalog: 'Produkte & Preise',
};

export function isSeoWarningScope(value: string): value is SeoWarningScope {
  return value === 'published' || value === 'draft' || value === 'catalog';
}

/** Unbekannte Scopes (künftige API) ⇒ neutral „Hinweis“. */
export function seoScopeLabel(scope: string): string {
  return isSeoWarningScope(scope) ? SEO_SCOPE_LABELS[scope] : 'Hinweis';
}

/** Antwort defensiv lesen: nur Hinweise mit Meldung; unerwartete Form ⇒ keine Hinweise. */
export function seoWarningsOf(data: SeoCheckResponse | null | undefined): SeoWarning[] {
  if (data === null || data === undefined || !Array.isArray(data.warnings)) return [];
  return data.warnings.filter(
    (warning) => typeof warning?.message === 'string' && warning.message.trim() !== '',
  );
}

const SEO_SCOPE_RANK: Record<SeoWarningScope, number> = { published: 0, draft: 1, catalog: 2 };

function seoScopeRank(scope: string): number {
  return isSeoWarningScope(scope) ? SEO_SCOPE_RANK[scope] : SEO_SCOPE_RANK.catalog + 1;
}

/** Veröffentlicht vor Entwurf vor Katalog, dann Pfad (ohne Pfad zuletzt), sonst Serverreihenfolge. */
export function sortSeoWarnings(warnings: readonly SeoWarning[]): SeoWarning[] {
  return [...warnings].sort((a, b) => {
    const byScope = seoScopeRank(a.scope) - seoScopeRank(b.scope);
    if (byScope !== 0) return byScope;
    if (a.path === null || b.path === null) {
      return a.path === b.path ? 0 : a.path === null ? 1 : -1;
    }
    return a.path.localeCompare(b.path);
  });
}

export function seoWarningsForEntry(
  warnings: readonly SeoWarning[],
  entryId: string,
): SeoWarning[] {
  return warnings.filter((warning) => warning.entryId === entryId);
}

/** Hinweise zu Produkten („Produkte & Preise“), die keinem CMS-Eintrag gehören. */
export function seoWarningsForCatalog(warnings: readonly SeoWarning[]): SeoWarning[] {
  return warnings.filter((warning) => warning.scope === 'catalog');
}

/** Hinweise je Eintrag (nur mit `entryId`); Reihenfolge wie übergeben. */
export function groupSeoWarningsByEntry(
  warnings: readonly SeoWarning[],
): Map<string, SeoWarning[]> {
  const groups = new Map<string, SeoWarning[]>();
  for (const warning of warnings) {
    if (warning.entryId === null) continue;
    const list = groups.get(warning.entryId) ?? [];
    list.push(warning);
    groups.set(warning.entryId, list);
  }
  return groups;
}

/** „1 Hinweis“ / „n Hinweise“. */
export function seoWarningCountLabel(count: number): string {
  return count === 1 ? '1 Hinweis' : `${count} Hinweise`;
}
