import { cmsMedia, products, type DatabaseExecutor } from '@mietroyal/database';
import { RequestValidationError, type z } from '@mietroyal/validation';
import {
  cmsMetaDescriptionSchema,
  cmsMetaTitleSchema,
  cmsPageContentSchema,
  cmsPageTypeIssues,
  cmsSiteSettingsSchema,
  collectCmsMediaIds,
  containsExactAddress,
  containsPriceText,
  exactAddressFragments,
  hasForbiddenTextCharacters,
  type CmsPageContent,
  type CmsPageTypeName,
  type CmsSiteSettings,
} from '@mietroyal/validation/cms';
import { inArray } from 'drizzle-orm';
import { getPickupExactAddress } from '../crm/settings-service.ts';
import { isSlushMachineProduct } from '../public/catalog.ts';
import { CMS_MESSAGES, CmsError, type CmsIssue } from './errors.ts';

/**
 * Phase 16 (CMS, Design §2.2/§11.2): Prüfregeln für Entwürfe und Veröffentlichungen –
 * an EINER Stelle, damit Speichern, Wiederherstellen, Veröffentlichen, Regionsanlage
 * und `cms:bootstrap` exakt dieselben Regeln anwenden.
 *
 * - Schema (`@mietroyal/validation/cms`, strictObject ⇒ kein Preisfeld, kein HTML);
 * - Preis-Freitext verboten (außer Rechtstexte), `CMS_PRICE_TEXT_FORBIDDEN`;
 * - exakte Abholadresse verboten (auch Rechtstexte), `CMS_EXACT_ADDRESS_FORBIDDEN`;
 * - referenzierte Medien müssen existieren, `CMS_MEDIA_UNKNOWN`;
 * - Empfehlungsregeln nur auf AKTIVE Slush-Maschinen, ohne Überschneidung;
 * - beim Veröffentlichen zusätzlich Seitentyp-Regeln + Meta-Titel.
 *
 * Fehlermeldungen nennen Feldpfade, nie Werte.
 */

export type CmsEntryShape =
  { kind: 'site_settings'; pageType: null } | { kind: 'page'; pageType: CmsPageTypeName };

export type CmsCheckedContent =
  { kind: 'site_settings'; content: CmsSiteSettings } | { kind: 'page'; content: CmsPageContent };

export interface CmsMetaInput {
  metaTitle: string | null;
  metaDescription: string | null;
}

function zodIssues(prefix: string, error: z.ZodError): CmsIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/** Schema-Prüfung je Eintragsart; liefert den normalisierten (getrimmten) Inhalt. */
export function parseEntryContent(entry: CmsEntryShape, raw: unknown): CmsCheckedContent {
  if (entry.kind === 'site_settings') {
    const parsed = cmsSiteSettingsSchema.safeParse(raw);
    if (!parsed.success) throw new RequestValidationError(zodIssues('content', parsed.error));
    return { kind: 'site_settings', content: parsed.data };
  }
  const parsed = cmsPageContentSchema.safeParse(raw);
  if (!parsed.success) throw new RequestValidationError(zodIssues('content', parsed.error));
  return { kind: 'page', content: parsed.data };
}

/** Meta-Titel/-Beschreibung: leer ⇒ null; sonst Schema (Länge, kein HTML, keine Steuerzeichen). */
export function parseMeta(input: {
  metaTitle?: string | null | undefined;
  metaDescription?: string | null | undefined;
}): CmsMetaInput {
  const issues: CmsIssue[] = [];
  const one = (
    field: 'metaTitle' | 'metaDescription',
    value: string | null | undefined,
    schema: typeof cmsMetaTitleSchema,
  ): string | null => {
    if (value === undefined || value === null || value.trim() === '') return null;
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      issues.push(...zodIssues(field, parsed.error));
      return null;
    }
    return parsed.data;
  };
  const metaTitle = one('metaTitle', input.metaTitle, cmsMetaTitleSchema);
  const metaDescription = one('metaDescription', input.metaDescription, cmsMetaDescriptionSchema);
  if (issues.length > 0) throw new RequestValidationError(issues);
  return { metaTitle, metaDescription };
}

/** Alle Textwerte mit Feldpfad (für Prüfmeldungen ohne Werte). */
function stringsWithPaths(value: unknown, path: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const visit = (node: unknown, at: string): void => {
    if (typeof node === 'string') out.push({ path: at, text: node });
    else if (Array.isArray(node)) node.forEach((child, index) => visit(child, `${at}.${index}`));
    else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) visit(child, `${at}.${key}`);
    }
  };
  visit(value, path);
  return out;
}

function textsOf(checked: CmsCheckedContent, meta: CmsMetaInput) {
  const texts = stringsWithPaths(checked.content, 'content');
  if (meta.metaTitle !== null) texts.push({ path: 'metaTitle', text: meta.metaTitle });
  if (meta.metaDescription !== null) {
    texts.push({ path: 'metaDescription', text: meta.metaDescription });
  }
  return texts;
}

/** Preis-Freitext (Design §11.2.1) und exakte Abholadresse (§11.2.2a). */
export async function assertTextRules(
  executor: DatabaseExecutor,
  entry: CmsEntryShape,
  checked: CmsCheckedContent,
  meta: CmsMetaInput,
): Promise<void> {
  const texts = textsOf(checked, meta);
  if (entry.pageType !== 'legal') {
    const priced = texts.filter((item) => containsPriceText(item.text));
    if (priced.length > 0) {
      throw new CmsError(
        'CMS_PRICE_TEXT_FORBIDDEN',
        CMS_MESSAGES.PRICE_TEXT_FORBIDDEN,
        priced.map((item) => ({ path: item.path, message: 'Enthält eine Preisangabe.' })),
      );
    }
  }
  const fragments = exactAddressFragments(await getPickupExactAddress(executor));
  const addressed = texts.filter((item) => containsExactAddress(item.text, fragments));
  if (addressed.length > 0) {
    throw new CmsError(
      'CMS_EXACT_ADDRESS_FORBIDDEN',
      CMS_MESSAGES.EXACT_ADDRESS_FORBIDDEN,
      addressed.map((item) => ({ path: item.path, message: 'Enthält die genaue Abholadresse.' })),
    );
  }
}

/** Alle referenzierten Medien müssen existieren; liefert die Medien-IDs (für `cms_revision_media`). */
export async function assertMediaExist(
  executor: DatabaseExecutor,
  checked: CmsCheckedContent,
): Promise<string[]> {
  const mediaIds = collectCmsMediaIds(checked.content);
  if (mediaIds.length === 0) return [];
  const rows = await executor
    .select({ id: cmsMedia.id })
    .from(cmsMedia)
    .where(inArray(cmsMedia.id, mediaIds));
  if (rows.length !== mediaIds.length) {
    throw new CmsError('CMS_MEDIA_UNKNOWN', CMS_MESSAGES.MEDIA_UNKNOWN);
  }
  return mediaIds;
}

/**
 * Empfehlungsregeln (Order §12): nur AKTIVE Slush-Maschinen (`isSlushMachineProduct`);
 * Überschneidungen lehnt bereits das Schema ab.
 */
export async function assertRecommendationRules(
  executor: DatabaseExecutor,
  settings: CmsSiteSettings,
): Promise<void> {
  const rules = settings.recommendationRules;
  if (rules.length === 0) return;
  const slugs = [...new Set(rules.map((rule) => rule.machineProductSlug))];
  const rows = await executor.select().from(products).where(inArray(products.slug, slugs));
  const allowed = new Set(
    rows.filter((row) => row.active && isSlushMachineProduct(row)).map((row) => row.slug),
  );
  const issues: CmsIssue[] = [];
  rules.forEach((rule, index) => {
    if (!allowed.has(rule.machineProductSlug)) {
      issues.push({
        path: `content.recommendationRules.${index}.machineProductSlug`,
        message: 'Keine aktive Slush-Maschine.',
      });
    }
  });
  if (issues.length > 0) {
    throw new CmsError('CMS_RECOMMENDATION_INVALID', CMS_MESSAGES.RECOMMENDATION_INVALID, issues);
  }
}

/** Alle Regeln für einen Entwurf (Speichern/Wiederherstellen/Bootstrap); liefert die Medien-IDs. */
export async function assertDraftRules(
  executor: DatabaseExecutor,
  entry: CmsEntryShape,
  checked: CmsCheckedContent,
  meta: CmsMetaInput,
): Promise<string[]> {
  await assertTextRules(executor, entry, checked, meta);
  if (checked.kind === 'site_settings') await assertRecommendationRules(executor, checked.content);
  return assertMediaExist(executor, checked);
}

/**
 * Zusätzliche Pflichten beim Veröffentlichen einer Seite: Seitentyp-Regeln
 * (`cmsPageTypeIssues`, z. B. Rechtstexte nur Text) und Meta-Titel.
 */
export function assertPublishable(
  entry: CmsEntryShape,
  checked: CmsCheckedContent,
  meta: CmsMetaInput,
): void {
  if (entry.kind !== 'page' || checked.kind !== 'page') return;
  const typeIssues = cmsPageTypeIssues(entry.pageType, checked.content);
  if (typeIssues.length > 0) {
    throw new CmsError(
      'CMS_CONTENT_INVALID',
      CMS_MESSAGES.CONTENT_INVALID,
      typeIssues.map((message) => ({ path: 'content.blocks', message })),
    );
  }
  if (meta.metaTitle === null) {
    throw new CmsError('CMS_PUBLISH_INCOMPLETE', CMS_MESSAGES.PUBLISH_INCOMPLETE, [
      { path: 'metaTitle', message: 'Bitte einen Meta-Titel angeben.' },
    ]);
  }
}

export const CMS_EDITOR_NOTE_MAX = 2000;

/** Interne Redaktionsnotiz (nie öffentlich): reiner Text, leer ⇒ null. */
export function parseEditorNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const issues: CmsIssue[] = [];
  if (trimmed.length > CMS_EDITOR_NOTE_MAX) {
    issues.push({ path: 'editorNote', message: `Höchstens ${CMS_EDITOR_NOTE_MAX} Zeichen.` });
  }
  // Review cms-3: dieselbe Zeichenregel wie die CMS-Texte (Cc/Cf/U+2028/U+2029, nur \n erlaubt).
  if (hasForbiddenTextCharacters(trimmed, { allowNewline: true })) {
    issues.push({ path: 'editorNote', message: 'Unzulässige Steuerzeichen.' });
  }
  if (issues.length > 0) throw new RequestValidationError(issues);
  return trimmed;
}
