import { cmsEntries, cmsRevisions, products, type DatabaseExecutor } from '@mietroyal/database';
import {
  cmsPageContentSchema,
  containsExactAddress,
  containsPriceText,
  exactAddressFragments,
  type CmsPageContent,
  type CmsPageTypeName,
} from '@mietroyal/validation/cms';
import { asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getPickupExactAddress } from '../crm/settings-service.ts';

/**
 * Phase 17 (SEO, Order §11/§23/§24, Design D12): Hinweise zur Suchmaschinen-Darstellung für
 * die Redaktion – NIE blockierend, keine Bewertung, kein „SEO-Score“, keine automatische
 * Umschreibung. Die Redaktion entscheidet.
 *
 * `computeSeoWarnings` ist eine reine Funktion über bereits geladenen Daten (Unit-Tests ohne
 * Datenbank); `loadSeoCheckInput`/`runSeoCheck` laden alle Einträge mit Entwurfs- und
 * veröffentlichter Revision, Slug/Name/Beschreibung/Verkaufseinheit der AKTIVEN Produkte (keine
 * Preise) sowie die Prüffragmente der exakten Abholadresse (nur zum Abgleich, nie ausgegeben).
 *
 * Geltungsbereiche (`scope`):
 * - `published`: die veröffentlichte Revision eines Eintrags (so sieht die Website aus);
 * - `draft`: der aktuelle Entwurf – nur, wenn er sich vom veröffentlichten Stand unterscheidet
 *   oder der Eintrag noch nie veröffentlicht wurde (sonst deckt `published` denselben Stand ab);
 * - `catalog`: Produktdaten, deren Text die öffentliche Projektion ausblendet (Design D13).
 *
 * Regeln: Meta-Titel/-Beschreibung fehlend, sehr kurz, sehr lang; exakt gleiche Meta-Titel bzw.
 * -Beschreibungen (NFKC + trim + lowercase, getrennt unter veröffentlichten Revisionen und unter
 * Entwürfen); leere Seite; interner Link auf eine Seite, die die Website nicht ausliefert (nicht
 * veröffentlicht, ungültiger Inhalt oder fail-closed wegen der Abholadresse – Review RC-4);
 * veröffentlichte Seite, die wegen der exakten Abholadresse in Titel/Meta-Titel entfällt;
 * Regionsseiten mit nahezu identischem Text (Jaccard der Wort-3-Gramme, zusätzlich Teilkopien
 * über Containment – Review RC-3); Produktname/-beschreibung/-verkaufseinheit mit Preis-Freitext
 * (Design D13, Review RC-1). Meldungen sind deutsch, ohne Codes und zitieren nie einen Preis oder
 * die Adresse.
 */

export const META_TITLE_MIN = 20;
export const META_TITLE_MAX_RECOMMENDED = 60;
export const META_DESCRIPTION_MIN = 50;
export const META_DESCRIPTION_MAX_RECOMMENDED = 160;
/**
 * Ähnlichkeit der Wort-3-Gramme (Jaccard bzw. Containment), ab der zwei Regionsseiten als
 * nahezu identisch gelten.
 */
export const REGION_SIMILARITY_THRESHOLD = 0.6;
/**
 * Phase 17 (Review RC-3): Containment (Schnitt / kleinere Menge) erkennt Teilkopien („Ortsnamen-
 * Tausch + ein Block entfernt“), gilt aber erst ab dieser Größe der kleineren Trigramm-Menge –
 * sonst würden kurze Seiten mit wenigen gemeinsamen Sätzen als Kopie gelten.
 */
export const REGION_CONTAINMENT_MIN_TRIGRAMS = 30;
/** App-Pfade (keine CMS-Seiten), die für die Linkprüfung immer existieren; `/konto/…` zählt ebenfalls. */
export const SEO_APP_PATHS: readonly string[] = ['/', '/konfigurator', '/konto'];

export type SeoWarningScope = 'draft' | 'published' | 'catalog';
export type SeoWarningField =
  'metaTitle' | 'metaDescription' | 'content' | 'links' | 'description' | 'name' | 'saleUnit';
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
  | 'PAGE_SUPPRESSED'
  | 'PRODUCT_DESCRIPTION_PRICE_HIDDEN'
  | 'PRODUCT_NAME_PRICE_HIDDEN'
  | 'PRODUCT_UNIT_PRICE_HIDDEN';

export interface SeoWarning {
  code: SeoWarningCode;
  scope: SeoWarningScope;
  /** Eintrag (null bei Produkt-Hinweisen). */
  entryId: string | null;
  /** Öffentlicher Pfad der Seite (null bei Produkt-Hinweisen). */
  path: string | null;
  field: SeoWarningField | null;
  /** Deutscher Hinweis ohne Code; nennt Pfade, Zeichenzahlen, Produktnamen/-Slugs – nie Preise. */
  message: string;
}

export interface SeoCheckRevision {
  metaTitle: string | null;
  metaDescription: string | null;
  /** Gespeicherter Inhalt (Seiteninhalt bzw. Website-Einstellungen). */
  content: unknown;
}

export interface SeoCheckEntry {
  entryId: string;
  kind: 'site_settings' | 'page';
  pageType: CmsPageTypeName | null;
  path: string | null;
  /** Aktueller Entwurf. */
  draft: SeoCheckRevision;
  /** Veröffentlichte Revision oder null (nie bzw. nicht mehr veröffentlicht). */
  published: SeoCheckRevision | null;
}

export interface SeoCheckProduct {
  slug: string;
  name: string;
  description: string | null;
  /** Verkaufseinheit (öffentlich `unitLabel`) – Freitext, daher ebenfalls preisgeprüft (Review RC-1). */
  saleUnit: string;
}

export interface SeoCheckInput {
  entries: readonly SeoCheckEntry[];
  /** AKTIVE Produkte (nur Slug, Name, Beschreibung, Verkaufseinheit – keine Preise). */
  products: readonly SeoCheckProduct[];
  /**
   * Prüffragmente der exakten Abholadresse (`exactAddressFragments`): eine veröffentlichte Seite
   * mit der Adresse in Titel oder Meta-Titel liefert die Website fail-closed nicht aus
   * (`PublicSiteService.publishedPages`). Fehlt der Wert, entfällt nur diese Prüfung.
   * Die Pfade der tatsächlich erreichbaren Seiten (Grundlage der Linkprüfung) leitet
   * `computeSeoWarnings` aus den veröffentlichten Revisionen ab (gültiger Inhalt, keine Adresse
   * in Titel/Meta-Titel) – Review RC-4.
   */
  addressFragments?: readonly string[] | undefined;
}

export interface SeoCheckResult {
  checkedAt: string;
  warnings: SeoWarning[];
}

// ── Textnormalisierung ───────────────────────────────────────────────────────

/** Zeichen (Codepunkte) eines getrimmten Textes. */
function textLength(value: string): number {
  return [...value.trim()].length;
}

/** Leer bzw. nur Leerraum ⇒ null (wie `parseMeta`, aber auch für direkt gespeicherte Werte). */
function presentText(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() === '' ? null : value;
}

/** Vergleichsform für Duplikate: NFKC, getrimmt, klein, Leerraum zusammengefasst. */
export function normalizeForDuplicateComparison(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Schlüssel, deren Werte kein redaktioneller Text sind (Diskriminator, Link, Medien-ID, Slugs, Alt-Text). */
const NON_TEXT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'href',
  'mediaId',
  'alt',
  'productSlugs',
]);

/** Redaktionelle Textwerte eines Inhalts – ohne Blocktypen, Links, Medien-IDs, Produkt-Slugs, Alt-Texte. */
export function editorialStrings(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.trim() !== '') out.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (!NON_TEXT_KEYS.has(key)) visit(child);
      }
    }
  };
  visit(value);
  return out;
}

/** Alle `href`-Werte eines Inhalts (Hero-CTAs, CTA-Blöcke – und künftige Blöcke mit Links). */
export function collectCmsHrefs(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'href' && typeof child === 'string') out.push(child);
        else visit(child);
      }
    }
  };
  visit(value);
  return out;
}

/** Wort-3-Gramme eines Textes (NFKC, klein, nur Buchstaben/Ziffern als Wörter). */
export function wordTrigrams(text: string): Set<string> {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word !== '');
  const grams = new Set<string>();
  for (let index = 0; index + 2 < words.length; index += 1) {
    grams.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return grams;
}

function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection;
}

/** Jaccard-Ähnlichkeit zweier Mengen (0 … 1); zwei leere Mengen gelten als unähnlich. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = intersectionSize(a, b);
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Containment (Review RC-3): Anteil der kleineren Menge, der in der größeren enthalten ist
 * (0 … 1) – erkennt Teilkopien, bei denen Jaccard durch den weggelassenen Teil sinkt.
 */
export function containmentSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return intersectionSize(a, b) / Math.min(a.size, b.size);
}

/**
 * Ähnlichkeit zweier Regionsseiten: Jaccard; sobald die kleinere Trigramm-Menge mindestens
 * `REGION_CONTAINMENT_MIN_TRIGRAMS` Elemente hat, zusätzlich Containment – der höhere Wert gilt
 * (Review RC-3: „Ortsnamen-Tausch + ein Block entfernt“ bleibt eine Kopie).
 */
export function regionSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const jaccard = jaccardSimilarity(a, b);
  if (Math.min(a.size, b.size) < REGION_CONTAINMENT_MIN_TRIGRAMS) return jaccard;
  return Math.max(jaccard, containmentSimilarity(a, b));
}

/** Interner Pfad ohne Fragment und ohne Schluss-Slash (`/faq/#oben` ⇒ `/faq`, `/#top` ⇒ `/`). */
export function normalizeInternalPath(href: string): string {
  const withoutFragment = href.split('#')[0] ?? '';
  const trimmed = withoutFragment.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * App-Pfad (`/`, `/konfigurator`, `/konto`, `/konto/…`) oder CMS-Seite, die die Website
 * tatsächlich ausliefert (`reachablePaths`, siehe `computeSeoWarnings`)?
 */
export function internalPathExists(path: string, reachablePaths: ReadonlySet<string>): boolean {
  if (SEO_APP_PATHS.includes(path)) return true;
  if (path.startsWith('/konto/')) return true;
  return reachablePaths.has(path);
}

/** Deterministische Serialisierung (sortierte Schlüssel) für den Vergleich zweier Revisionen. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameRevision(a: SeoCheckRevision, b: SeoCheckRevision): boolean {
  return (
    presentText(a.metaTitle) === presentText(b.metaTitle) &&
    presentText(a.metaDescription) === presentText(b.metaDescription) &&
    stableStringify(a.content) === stableStringify(b.content)
  );
}

// ── Prüfung ──────────────────────────────────────────────────────────────────

/** Eine zu prüfende Revision einer Seite (Entwurf oder veröffentlicht). */
interface PageRevisionView {
  entryId: string;
  path: string;
  pageType: CmsPageTypeName;
  scope: 'draft' | 'published';
  revision: SeoCheckRevision;
  /** Geparster Seiteninhalt; null, wenn der gespeicherte Inhalt dem Schema nicht entspricht. */
  content: CmsPageContent | null;
  /**
   * Entwurf, der sich vom veröffentlichten Stand unterscheidet (oder nie veröffentlicht) –
   * nur solche Entwürfe erhalten eigene Hinweise; `published`-Sichten sind immer „pending“.
   */
  pending: boolean;
  /**
   * Veröffentlichte Sicht, die wegen der exakten Abholadresse in Titel oder Meta-Titel von der
   * Website fail-closed nicht ausgeliefert wird (Review RC-4a; Entwürfe: immer false).
   */
  addressSuppressed: boolean;
  /**
   * Veröffentlichte Sicht, die die Website tatsächlich ausliefert: gültiger Inhalt und keine
   * Adresse in Titel/Meta-Titel (Review RC-4; Entwürfe: immer false).
   */
  reachable: boolean;
}

/** Wie `PublicSiteService.publishedPages`: Adresse im Seitentitel oder Meta-Titel ⇒ Seite entfällt. */
function titleRevealsAddress(
  content: CmsPageContent,
  revision: SeoCheckRevision,
  fragments: readonly string[],
): boolean {
  if (fragments.length === 0) return false;
  return [content.title, revision.metaTitle].some(
    (text) => text !== null && containsExactAddress(text, fragments),
  );
}

function pageViews(
  entries: readonly SeoCheckEntry[],
  fragments: readonly string[],
): {
  published: PageRevisionView[];
  drafts: PageRevisionView[];
} {
  const published: PageRevisionView[] = [];
  const drafts: PageRevisionView[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'page' || entry.path === null || entry.pageType === null) continue;
    const parse = (revision: SeoCheckRevision): CmsPageContent | null => {
      const parsed = cmsPageContentSchema.safeParse(revision.content);
      return parsed.success ? parsed.data : null;
    };
    if (entry.published !== null) {
      const content = parse(entry.published);
      const addressSuppressed =
        content !== null && titleRevealsAddress(content, entry.published, fragments);
      published.push({
        entryId: entry.entryId,
        path: entry.path,
        pageType: entry.pageType,
        scope: 'published',
        revision: entry.published,
        content,
        pending: true,
        addressSuppressed,
        reachable: content !== null && !addressSuppressed,
      });
    }
    drafts.push({
      entryId: entry.entryId,
      path: entry.path,
      pageType: entry.pageType,
      scope: 'draft',
      revision: entry.draft,
      content: parse(entry.draft),
      pending: entry.published === null || !sameRevision(entry.draft, entry.published),
      addressSuppressed: false,
      reachable: false,
    });
  }
  return { published, drafts };
}

const SCOPE_LABEL: Record<'draft' | 'published', string> = {
  draft: 'Der Entwurf',
  published: 'Die veröffentlichte Seite',
};

function warn(
  view: PageRevisionView,
  code: SeoWarningCode,
  field: SeoWarningField,
  message: string,
): SeoWarning {
  return { code, scope: view.scope, entryId: view.entryId, path: view.path, field, message };
}

function metaWarnings(view: PageRevisionView): SeoWarning[] {
  const out: SeoWarning[] = [];
  const title = presentText(view.revision.metaTitle);
  if (title === null) {
    out.push(
      warn(
        view,
        'META_TITLE_MISSING',
        'metaTitle',
        view.scope === 'draft'
          ? 'Der Entwurf hat keinen Meta-Titel. Ohne Meta-Titel kann die Seite nicht veröffentlicht werden.'
          : 'Die veröffentlichte Seite hat keinen Meta-Titel. Suchmaschinen zeigen dann einen selbst gewählten Titel an.',
      ),
    );
  } else {
    const length = textLength(title);
    if (length < META_TITLE_MIN) {
      out.push(
        warn(
          view,
          'META_TITLE_SHORT',
          'metaTitle',
          `Der Meta-Titel ist sehr kurz (${length} Zeichen). Empfohlen sind ${META_TITLE_MIN}–${META_TITLE_MAX_RECOMMENDED} Zeichen.`,
        ),
      );
    } else if (length > META_TITLE_MAX_RECOMMENDED) {
      out.push(
        warn(
          view,
          'META_TITLE_LONG',
          'metaTitle',
          `Der Meta-Titel ist sehr lang (${length} Zeichen). Empfohlen sind ${META_TITLE_MIN}–${META_TITLE_MAX_RECOMMENDED} Zeichen – längere Titel werden in Suchergebnissen abgeschnitten.`,
        ),
      );
    }
  }
  const description = presentText(view.revision.metaDescription);
  if (description === null) {
    out.push(
      warn(
        view,
        'META_DESCRIPTION_MISSING',
        'metaDescription',
        `${SCOPE_LABEL[view.scope]} hat keine Meta-Beschreibung. Suchmaschinen zeigen dann einen beliebigen Textausschnitt der Seite.`,
      ),
    );
  } else {
    const length = textLength(description);
    if (length < META_DESCRIPTION_MIN) {
      out.push(
        warn(
          view,
          'META_DESCRIPTION_SHORT',
          'metaDescription',
          `Die Meta-Beschreibung ist sehr kurz (${length} Zeichen). Empfohlen sind ${META_DESCRIPTION_MIN}–${META_DESCRIPTION_MAX_RECOMMENDED} Zeichen.`,
        ),
      );
    } else if (length > META_DESCRIPTION_MAX_RECOMMENDED) {
      out.push(
        warn(
          view,
          'META_DESCRIPTION_LONG',
          'metaDescription',
          `Die Meta-Beschreibung ist sehr lang (${length} Zeichen). Empfohlen sind ${META_DESCRIPTION_MIN}–${META_DESCRIPTION_MAX_RECOMMENDED} Zeichen – längere Beschreibungen werden in Suchergebnissen abgeschnitten.`,
        ),
      );
    }
  }
  return out;
}

function contentWarnings(
  view: PageRevisionView,
  reachablePaths: ReadonlySet<string>,
): SeoWarning[] {
  if (view.content === null) return [];
  const out: SeoWarning[] = [];
  // Review RC-4a: die Website liefert die Seite nicht aus – Hinweis ohne die Adresse zu zitieren.
  if (view.addressSuppressed) {
    out.push(
      warn(
        view,
        'PAGE_SUPPRESSED',
        'content',
        'Die veröffentlichte Seite wird auf der Website nicht ausgeliefert, weil Titel oder Meta-Titel die exakte Abholadresse enthalten.',
      ),
    );
  }
  if (view.content.blocks.length === 0) {
    out.push(
      warn(
        view,
        'PAGE_EMPTY',
        'content',
        `${SCOPE_LABEL[view.scope]} hat außer dem Titel keinen Inhalt.`,
      ),
    );
  } else if (editorialStrings(view.content.blocks).length === 0) {
    out.push(
      warn(
        view,
        'PAGE_EMPTY',
        'content',
        `${SCOPE_LABEL[view.scope]} enthält keinen eigenen Text – nur Bilder oder automatisch befüllte Bausteine.`,
      ),
    );
  }
  const broken = new Set<string>();
  for (const href of collectCmsHrefs(view.content.blocks)) {
    if (!href.startsWith('/')) continue;
    const path = normalizeInternalPath(href);
    if (!internalPathExists(path, reachablePaths)) broken.add(path);
  }
  for (const path of [...broken].sort()) {
    out.push(
      warn(
        view,
        'BROKEN_INTERNAL_LINK',
        'links',
        `Der Link „${path}“ führt auf eine Seite, die derzeit nicht veröffentlicht ist. Die Website blendet diesen Link aus, bis die Seite veröffentlicht ist.`,
      ),
    );
  }
  return out;
}

function duplicateWarnings(
  views: readonly PageRevisionView[],
  field: 'metaTitle' | 'metaDescription',
): SeoWarning[] {
  const groups = new Map<string, PageRevisionView[]>();
  for (const view of views) {
    const value = presentText(view.revision[field]);
    if (value === null) continue;
    const key = normalizeForDuplicateComparison(value);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [view]);
    else group.push(view);
  }
  const out: SeoWarning[] = [];
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((view) => view.pending)) continue;
    const paths = group.map((view) => view.path).sort();
    const scope = group[0]!.scope;
    const what = field === 'metaTitle' ? 'Dieser Meta-Titel' : 'Diese Meta-Beschreibung';
    const where =
      scope === 'published' ? 'auf mehreren veröffentlichten Seiten' : 'in mehreren Entwürfen';
    const need =
      field === 'metaTitle' ? 'einen eigenen Meta-Titel' : 'eine eigene Meta-Beschreibung';
    const message = `${what} ist ${where} identisch: ${paths.join(', ')}. Jede Seite braucht ${need}.`;
    for (const view of group) {
      if (!view.pending) continue;
      out.push(
        warn(
          view,
          field === 'metaTitle' ? 'META_TITLE_DUPLICATE' : 'META_DESCRIPTION_DUPLICATE',
          field,
          message,
        ),
      );
    }
  }
  return out;
}

/** Text einer Seite für den Ähnlichkeitsvergleich: Titel und alle redaktionellen Texte der Blöcke. */
export function pageComparisonText(content: CmsPageContent): string {
  return [content.title, ...editorialStrings(content.blocks)].join(' ');
}

function regionWarnings(views: readonly PageRevisionView[]): SeoWarning[] {
  const regions = views
    .filter((view) => view.pageType === 'region' && view.content !== null)
    .map((view) => ({ view, grams: wordTrigrams(pageComparisonText(view.content!)) }));
  const out: SeoWarning[] = [];
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i]!;
      const b = regions[j]!;
      if (!a.view.pending && !b.view.pending) continue;
      const similarity = regionSimilarity(a.grams, b.grams);
      if (similarity < REGION_SIMILARITY_THRESHOLD) continue;
      const percent = Math.round(similarity * 100);
      for (const [self, other] of [
        [a, b],
        [b, a],
      ] as const) {
        if (!self.view.pending) continue;
        out.push(
          warn(
            self.view,
            'REGION_NEAR_DUPLICATE',
            'content',
            `Der Text ähnelt stark der Regionsseite ${other.view.path} (Ähnlichkeit ${percent} %). Regionsseiten brauchen eigenständige Inhalte – kein bloßer Ortsnamen-Tausch.`,
          ),
        );
      }
    }
  }
  return out;
}

/** Katalog-Hinweis (kein Eintrag, kein Pfad). */
function catalogWarning(code: SeoWarningCode, field: SeoWarningField, message: string): SeoWarning {
  return { code, scope: 'catalog', entryId: null, path: null, field, message };
}

/** Produktverwaltung des Commerce-Moduls (Staff `/produkte`) – dort werden Name, Beschreibung, Verkaufseinheit gepflegt. */
const PRODUCT_ADMIN_LABEL = 'in der Produktverwaltung („Produkte & Preise“)';

function productWarnings(list: readonly SeoCheckProduct[]): SeoWarning[] {
  const out: SeoWarning[] = [];
  for (const product of list) {
    const nameHasPrice = containsPriceText(product.name);
    // Ein Name mit Preisangabe wird nie zitiert – dann genügt der Slug.
    const label = nameHasPrice ? `mit dem Kürzel „${product.slug}“` : `„${product.name}“`;
    if (nameHasPrice) {
      out.push(
        catalogWarning(
          'PRODUCT_NAME_PRICE_HIDDEN',
          'name',
          `Der Name des Produkts ${label} enthält eine Preisangabe. Das Produkt wird auf der Website deshalb nicht angezeigt – bitte den Namen ${PRODUCT_ADMIN_LABEL} anpassen.`,
        ),
      );
    }
    // Review RC-1: die Verkaufseinheit blendet das Produkt ebenso aus wie der Name.
    if (containsPriceText(product.saleUnit)) {
      out.push(
        catalogWarning(
          'PRODUCT_UNIT_PRICE_HIDDEN',
          'saleUnit',
          `Die Verkaufseinheit des Produkts ${label} enthält eine Preisangabe. Das Produkt wird auf der Website deshalb nicht angezeigt – bitte die Verkaufseinheit ${PRODUCT_ADMIN_LABEL} anpassen.`,
        ),
      );
    }
    if (product.description !== null && containsPriceText(product.description)) {
      out.push(
        catalogWarning(
          'PRODUCT_DESCRIPTION_PRICE_HIDDEN',
          'description',
          `Die Beschreibung des Produkts ${label} enthält eine Preisangabe. Auf der Website wird die Beschreibung deshalb nicht angezeigt – Preise kommen ausschließlich aus der Produktverwaltung („Produkte & Preise“).`,
        ),
      );
    }
  }
  return out;
}

const SCOPE_ORDER: Record<SeoWarningScope, number> = { published: 0, draft: 1, catalog: 2 };

function compareWarnings(a: SeoWarning, b: SeoWarning): number {
  const scope = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
  if (scope !== 0) return scope;
  const pathA = a.path ?? '';
  const pathB = b.path ?? '';
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

/**
 * Reine Prüfung (ohne Datenbank). Reihenfolge der Ausgabe: veröffentlicht, Entwurf, Katalog;
 * innerhalb nach Pfad, Code, Meldung – deterministisch.
 *
 * Erreichbare Pfade für die Linkprüfung (Review RC-4) = veröffentlichte Revisionen mit gültigem
 * Inhalt und ohne Adresse in Titel/Meta-Titel – dieselben Regeln wie der öffentliche Bootstrap
 * (`PublicSiteService.publishedPages`), damit „kaputter Link“ und „Seite nicht gefunden“
 * zusammenfallen.
 */
export function computeSeoWarnings(input: SeoCheckInput): SeoWarning[] {
  const { published, drafts } = pageViews(input.entries, input.addressFragments ?? []);
  const reachablePaths = new Set(
    published.filter((view) => view.reachable).map((view) => view.path),
  );
  const pendingDrafts = drafts.filter((view) => view.pending);
  const out: SeoWarning[] = [];
  for (const view of [...published, ...pendingDrafts]) {
    out.push(...metaWarnings(view), ...contentWarnings(view, reachablePaths));
  }
  for (const field of ['metaTitle', 'metaDescription'] as const) {
    out.push(...duplicateWarnings(published, field), ...duplicateWarnings(drafts, field));
  }
  out.push(...regionWarnings(published), ...regionWarnings(drafts));
  out.push(...productWarnings(input.products));
  return out.sort(compareWarnings);
}

// ── Datenbeschaffung ─────────────────────────────────────────────────────────

/**
 * Alle Einträge mit Entwurfs- und veröffentlichter Revision (ein Join), die AKTIVEN Produkte
 * (nur Slug, Name, Beschreibung, Verkaufseinheit) und die Prüffragmente der exakten Abholadresse
 * (dieselbe Quelle wie die öffentliche Projektion). Einträge ohne Entwurf entfallen.
 */
export async function loadSeoCheckInput(executor: DatabaseExecutor): Promise<SeoCheckInput> {
  const draft = alias(cmsRevisions, 'draft_revision');
  const published = alias(cmsRevisions, 'published_revision');
  const rows = await executor
    .select({
      id: cmsEntries.id,
      kind: cmsEntries.kind,
      pageType: cmsEntries.pageType,
      path: cmsEntries.path,
      draftId: draft.id,
      draftMetaTitle: draft.metaTitle,
      draftMetaDescription: draft.metaDescription,
      draftContent: draft.content,
      publishedId: published.id,
      publishedMetaTitle: published.metaTitle,
      publishedMetaDescription: published.metaDescription,
      publishedContent: published.content,
    })
    .from(cmsEntries)
    .leftJoin(draft, eq(draft.id, cmsEntries.draftRevisionId))
    .leftJoin(published, eq(published.id, cmsEntries.publishedRevisionId))
    .orderBy(asc(cmsEntries.kind), asc(cmsEntries.path));
  const entries: SeoCheckEntry[] = [];
  for (const row of rows) {
    if (row.draftId === null) continue;
    entries.push({
      entryId: row.id,
      kind: row.kind,
      pageType: (row.pageType as CmsPageTypeName | null) ?? null,
      path: row.path,
      draft: {
        metaTitle: row.draftMetaTitle,
        metaDescription: row.draftMetaDescription,
        content: row.draftContent,
      },
      published:
        row.publishedId === null
          ? null
          : {
              metaTitle: row.publishedMetaTitle,
              metaDescription: row.publishedMetaDescription,
              content: row.publishedContent,
            },
    });
  }
  const productRows = await executor
    .select({
      slug: products.slug,
      name: products.name,
      description: products.description,
      saleUnit: products.saleUnit,
    })
    .from(products)
    .where(eq(products.active, true))
    .orderBy(asc(products.sortOrder), asc(products.name));
  return {
    entries,
    products: productRows,
    addressFragments: exactAddressFragments(await getPickupExactAddress(executor)),
  };
}

/** `GET /staff/cms/seo-check`: Zeitpunkt der Prüfung und alle Hinweise. */
export async function runSeoCheck(
  executor: DatabaseExecutor,
  now = new Date(),
): Promise<SeoCheckResult> {
  const input = await loadSeoCheckInput(executor);
  return { checkedAt: now.toISOString(), warnings: computeSeoWarnings(input) };
}
