import { describe, expect, it } from 'vitest';
import {
  CMS_FIXED_PAGE_PATHS,
  CMS_IMPRINT_PATH,
  CMS_PRIVACY_PATH,
  CMS_REGION_PATH_PREFIX,
  CMS_SECONDARY_OFFER_PATHS,
  cmsHrefSchema,
  cmsMetaDescriptionSchema,
  cmsMetaTitleSchema,
  cmsPageContentSchema,
  cmsPageTypeIssues,
  cmsSiteSettingsSchema,
  collectCmsMediaIds,
  collectCmsStrings,
  containsPriceText,
  isValidCmsPathForPageType,
  type CmsBlock,
  type CmsCta,
  type CmsPageTypeName,
} from '@mietroyal/validation/cms';
import { CMS_BOOTSTRAP_ENTRIES, type CmsBootstrapEntry } from '../src/cms/bootstrap-content.ts';

/**
 * Phase 16 (CONTENT, Design §7/§11.2.13/§11.3): Pflichttest der redaktionellen
 * Erst-Entwürfe für `pnpm cms:bootstrap` – reine Daten, ohne Datenbank.
 * Prüft Schema + Seitentyp-Regeln (wie Speichern/Veröffentlichen), Pfade, Preis-Freitext,
 * Sperrliste (Altbestand-Adresse, Kapazität, Buchungs-Sprache, Währung), Links und die
 * Fakten-Grenzen (keine Ortsnamen-Schablone, Popcorn/Waffel ohne Geschäftsdaten).
 */

type PageEntry = Extract<CmsBootstrapEntry, { kind: 'page' }>;
type SettingsEntry = Extract<CmsBootstrapEntry, { kind: 'site_settings' }>;

const pages = CMS_BOOTSTRAP_ENTRIES.filter((entry): entry is PageEntry => entry.kind === 'page');
const settingsEntries = CMS_BOOTSTRAP_ENTRIES.filter(
  (entry): entry is SettingsEntry => entry.kind === 'site_settings',
);

/** Pflicht-Einträge laut Design §2.1. */
const REQUIRED_PAGES: ReadonlyArray<{ pageType: CmsPageTypeName; path: string }> = [
  { pageType: 'home', path: CMS_FIXED_PAGE_PATHS.home },
  { pageType: 'slush', path: CMS_FIXED_PAGE_PATHS.slush },
  { pageType: 'process', path: CMS_FIXED_PAGE_PATHS.process },
  { pageType: 'faq', path: CMS_FIXED_PAGE_PATHS.faq },
  { pageType: 'about', path: CMS_FIXED_PAGE_PATHS.about },
  { pageType: 'contact', path: CMS_FIXED_PAGE_PATHS.contact },
  { pageType: 'legal', path: CMS_IMPRINT_PATH },
  { pageType: 'legal', path: CMS_PRIVACY_PATH },
  ...CMS_SECONDARY_OFFER_PATHS.map((path) => ({ pageType: 'secondary_offer' as const, path })),
  { pageType: 'region', path: `${CMS_REGION_PATH_PREFIX}mainz` },
  { pageType: 'region', path: `${CMS_REGION_PATH_PREFIX}wiesbaden` },
  { pageType: 'region', path: `${CMS_REGION_PATH_PREFIX}bad-kreuznach` },
];

/** Ortsname je Regionsseite (für die Schablonen-Prüfung). */
const REGION_PLACE_NAMES: Readonly<Record<string, string>> = {
  [`${CMS_REGION_PATH_PREFIX}mainz`]: 'Mainz',
  [`${CMS_REGION_PATH_PREFIX}wiesbaden`]: 'Wiesbaden',
  [`${CMS_REGION_PATH_PREFIX}bad-kreuznach`]: 'Bad Kreuznach',
};

/** Seiten der Web-App, die unabhängig vom CMS existieren. */
const APP_PATHS: readonly string[] = ['/', '/konfigurator', '/konto'];

/** Design §11.2.13 – Test-Sperrliste (Groß-/Kleinschreibung egal), gilt für ALLE Texte. */
const BLOCKLIST: readonly string[] = [
  'heiligkreuzweg',
  '55130',
  'hem-tankstelle',
  'schinnergraben',
  'techremedys',
  'becher pro stunde',
  'jetzt buchen',
  'verbindlich buchen',
  '€',
  ' eur',
  'euro',
];

/**
 * Altlasten der bisherigen Website (docs/WEBSITE_MIGRATION_NOTES.md „Nicht übernehmen“) und
 * Fakten-Grenzen aus Design §7 – gelten für alle öffentlichen Texte.
 */
const NOT_ADOPTED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /(pro|je)\s+stunde|\/\s*stunde/i, reason: 'Kapazität je Zeiteinheit' },
  { pattern: /pro\s+tag/i, reason: 'Preis-/Kapazitätsbezug „pro Tag“' },
  { pattern: /\bbuchen\b/i, reason: '„buchen“-Versprechen (Website erzeugt nur Anfragen)' },
  { pattern: /blaubeere/i, reason: 'Sirupsorte der Alt-Website (MASTER_SPEC §5)' },
  { pattern: /softeis/i, reason: 'Softeis nicht im Angebot' },
  { pattern: /whatsapp/i, reason: 'kein WhatsApp-Widget/-Button' },
  { pattern: /erento/i, reason: 'keine fremden Bewertungen' },
  { pattern: /all-inclusive/i, reason: 'unbelegte Paketaussage' },
  { pattern: /endreinigung/i, reason: 'nicht belegt (MASTER_SPEC §13)' },
  { pattern: /24\s*stunden/i, reason: 'unbelegtes Antwortversprechen' },
  { pattern: /newsletter/i, reason: 'kein Newsletter' },
  { pattern: /kostenlos|kostenfrei/i, reason: 'unbelegte Kostenaussage' },
  { pattern: /%/, reason: 'keine Prozentsätze (Storno/Rabatt nur aus zentraler Logik)' },
  { pattern: /instagram\.com/i, reason: 'keine Instagram-URL belegt' },
];

function pageStrings(entry: PageEntry): string[] {
  const out = collectCmsStrings(entry.content);
  if (entry.metaTitle !== undefined) out.push(entry.metaTitle);
  if (entry.metaDescription !== undefined) out.push(entry.metaDescription);
  return out;
}

/** Öffentlich sichtbare Texte (ohne interne Redaktionsnotiz). */
function publicStrings(entry: CmsBootstrapEntry): string[] {
  return entry.kind === 'page' ? pageStrings(entry) : collectCmsStrings(entry.content);
}

function allStrings(entry: CmsBootstrapEntry): string[] {
  const out = publicStrings(entry);
  if (entry.editorNote !== undefined) out.push(entry.editorNote);
  return out;
}

function targetOf(entry: CmsBootstrapEntry): string {
  return entry.kind === 'page' ? entry.path : 'site_settings';
}

function ctasOf(block: CmsBlock): CmsCta[] {
  if (block.type === 'hero') {
    return [block.primaryCta, block.secondaryCta].filter((cta): cta is CmsCta => cta !== undefined);
  }
  if (block.type === 'cta') {
    return [block.primary, block.secondary].filter((cta): cta is CmsCta => cta !== undefined);
  }
  return [];
}

function pageAt(path: string): PageEntry {
  const page = pages.find((entry) => entry.path === path);
  if (page === undefined) throw new Error(`Bootstrap-Seite fehlt: ${path}`);
  return page;
}

describe('Phase 16 (CONTENT): CMS-Bootstrap-Inhalte', () => {
  it('enthält genau die Pflicht-Einträge aus Design §2.1 – ohne doppelte Pfade, ohne Massenerzeugung', () => {
    expect(settingsEntries).toHaveLength(1);
    const paths = pages.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const required of REQUIRED_PAGES) {
      expect(pageAt(required.path).pageType, required.path).toBe(required.pageType);
    }
    expect(pages).toHaveLength(REQUIRED_PAGES.length);
  });

  it('jede Seite ist schema-gültig, unverändert normalisiert, passt zum Pfad und ist veröffentlichungsfähig', () => {
    for (const entry of pages) {
      const parsed = cmsPageContentSchema.safeParse(entry.content);
      expect(parsed.success ? [] : parsed.error.issues, entry.path).toEqual([]);
      // Der Bootstrap speichert den normalisierten Inhalt – er muss dem Quelltext entsprechen.
      expect(parsed.data, entry.path).toEqual(entry.content);
      expect(cmsPageTypeIssues(entry.pageType, entry.content), entry.path).toEqual([]);
      expect(isValidCmsPathForPageType(entry.pageType, entry.path), entry.path).toBe(true);
      // Veröffentlichen verlangt einen Meta-Titel (Design §2.2); Beschreibung für SEO (Order §23).
      expect(entry.metaTitle, entry.path).toBeDefined();
      expect(cmsMetaTitleSchema.safeParse(entry.metaTitle).success, entry.path).toBe(true);
      expect(cmsMetaTitleSchema.parse(entry.metaTitle), entry.path).toBe(entry.metaTitle);
      expect(entry.metaDescription, entry.path).toBeDefined();
      expect(cmsMetaDescriptionSchema.safeParse(entry.metaDescription).success, entry.path).toBe(
        true,
      );
      expect(cmsMetaDescriptionSchema.parse(entry.metaDescription), entry.path).toBe(
        entry.metaDescription,
      );
    }
  });

  it('Website-Einstellungen: schema-gültig, „Miet-Royal“, keine Instagram-URL, keine Empfehlungsregeln, Kontakt als Entwurf', () => {
    const [entry] = settingsEntries;
    if (entry === undefined) throw new Error('site_settings fehlt');
    const parsed = cmsSiteSettingsSchema.safeParse(entry.content);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    expect(parsed.data).toEqual(entry.content);
    expect(entry.content.businessName).toBe('Miet-Royal');
    expect(entry.content.instagramUrl).toBeUndefined();
    expect(entry.content.recommendationRules).toEqual([]);
    expect(entry.content.logo).toBeUndefined();
    expect(entry.content.contact.phone).toBeDefined();
    expect(entry.content.contact.email).toBeDefined();
    expect(entry.editorNote).toContain('vor Veröffentlichung bestätigen');
  });

  it('referenziert keine Medien (Bilder erst nach Klärung von Eigentum und Einwilligungen)', () => {
    for (const entry of CMS_BOOTSTRAP_ENTRIES) {
      expect(collectCmsMediaIds(entry.content), targetOf(entry)).toEqual([]);
    }
  });

  it('kein Preis-Freitext – auch nicht in Titel, Meta-Angaben, Rechtstexten und Redaktionsnotizen', () => {
    for (const entry of CMS_BOOTSTRAP_ENTRIES) {
      const priced = allStrings(entry).filter((text) => containsPriceText(text));
      expect(priced, targetOf(entry)).toEqual([]);
    }
  });

  it('Sperrliste aus Design §11.2.13 kommt in keinem Text vor (inkl. Redaktionsnotizen)', () => {
    for (const entry of CMS_BOOTSTRAP_ENTRIES) {
      const hits = allStrings(entry).flatMap((text) => {
        const lower = text.toLowerCase();
        return BLOCKLIST.filter((term) => lower.includes(term));
      });
      expect(hits, targetOf(entry)).toEqual([]);
    }
  });

  it('keine Altlasten der bisherigen Website und keine Adress-/PLZ-Angaben in öffentlichen Texten', () => {
    // Straße + Hausnummer bzw. alleinstehende Postleitzahl (Steuernummer „…/63574“ ausgenommen).
    const streetLike = /\p{L}(straße|strasse|str\.|weg|gasse|allee|platz|ring)\s+\d/iu;
    const postalCode = /(^|[^\d/])\d{5}(?![\d/])/;
    for (const entry of CMS_BOOTSTRAP_ENTRIES) {
      const texts = publicStrings(entry);
      const hits = texts.flatMap((text) =>
        NOT_ADOPTED.filter(({ pattern }) => pattern.test(text)).map(({ reason }) => reason),
      );
      expect(hits, targetOf(entry)).toEqual([]);
      expect(
        texts.filter((text) => streetLike.test(text) || postalCode.test(text)),
        targetOf(entry),
      ).toEqual([]);
    }
  });

  it('Kontaktwerte stehen nur in den Website-Einstellungen (und den Rechtstexten), Seiten nutzen contact_details', () => {
    for (const entry of pages) {
      if (entry.pageType === 'legal') continue;
      const hits = pageStrings(entry).filter((text) => /@|\+49|tel:|mailto:/i.test(text));
      expect(hits, entry.path).toEqual([]);
    }
  });

  it('Ansprache „du“: keine Sie-/Ihr-Formen und kein „euch“ in öffentlichen Texten', () => {
    const formal = /\b(Sie|Ihnen|Ihr|Ihre|Ihrer|Ihren|Ihrem|Ihres)\b/;
    const plural = /\b(euch|euer|eure|euren|eurem|eures)\b/i;
    for (const entry of CMS_BOOTSTRAP_ENTRIES) {
      const hits = publicStrings(entry).filter((text) => formal.test(text) || plural.test(text));
      expect(hits, targetOf(entry)).toEqual([]);
    }
  });

  it('alle Links sind intern (existierende Seite) oder mailto:/tel: – nie extern', () => {
    const known = new Set<string>([...APP_PATHS, ...pages.map((entry) => entry.path)]);
    for (const entry of pages) {
      for (const block of entry.content.blocks) {
        for (const cta of ctasOf(block)) {
          expect(cmsHrefSchema.safeParse(cta.href).success, `${entry.path}: ${cta.href}`).toBe(
            true,
          );
          if (/^(mailto|tel):/.test(cta.href)) continue;
          expect(cta.href.startsWith('/') && !cta.href.startsWith('//'), entry.path).toBe(true);
          expect(known.has(cta.href.split('#')[0] ?? ''), `${entry.path}: ${cta.href}`).toBe(true);
        }
      }
    }
  });

  it('Haupt-CTA „Slush konfigurieren“ führt zum Konfigurator; „Unverbindlich anfragen“ zu Konfigurator oder Kontakt', () => {
    const configure = { label: 'Slush konfigurieren', href: '/konfigurator' };
    for (const entry of pages) {
      if (entry.pageType === 'legal') {
        expect(
          entry.content.blocks.every((block) => block.type === 'text'),
          entry.path,
        ).toBe(true);
        continue;
      }
      const hero = entry.content.blocks[0];
      expect(hero?.type, entry.path).toBe('hero');
      if (hero?.type !== 'hero') continue;
      if (entry.pageType === 'secondary_offer') {
        // Popcorn/Waffel: der Konfigurator kann nur Slush – Kontakt zuerst, Slush als Zweites.
        expect(hero.secondaryCta, entry.path).toEqual(configure);
      } else {
        expect(hero.primaryCta, entry.path).toEqual(configure);
      }
      for (const cta of entry.content.blocks.flatMap(ctasOf)) {
        if (cta.label === configure.label) expect(cta.href, entry.path).toBe(configure.href);
        if (cta.label === 'Unverbindlich anfragen') {
          expect(['/konfigurator', '/kontakt'], entry.path).toContain(cta.href);
        }
      }
    }
  });

  it('Rechtstexte: redaktionelle Entwürfe mit Prüfnotiz „vor Live rechtlich prüfen“, Anschrift nicht übernommen', () => {
    for (const path of [CMS_IMPRINT_PATH, CMS_PRIVACY_PATH]) {
      const entry = pageAt(path);
      expect(entry.pageType).toBe('legal');
      expect(entry.editorNote, path).toContain('vor Live rechtlich prüfen');
      expect(entry.editorNote, path).toMatch(/TMG|YouTube/);
    }
    const privacy = pageStrings(pageAt(CMS_PRIVACY_PATH)).join('\n');
    expect(privacy).toContain('Anschrift: wie im Impressum angegeben');
    expect(privacy).toContain('betroffene Person');
  });

  it('Popcorn/Waffel: nur Struktur – keine Produkt-/Inklusiv-Blöcke, keine Zahlen, Notiz zu fehlenden Geschäftsdaten', () => {
    for (const path of CMS_SECONDARY_OFFER_PATHS) {
      const entry = pageAt(path);
      const types = entry.content.blocks.map((block) => block.type);
      expect(types, path).not.toContain('product_grid');
      expect(types, path).not.toContain('included_items');
      expect(
        collectCmsStrings(entry.content).filter((text) => /\d/.test(text)),
        path,
      ).toEqual([]);
      expect(entry.editorNote, path).toMatch(/Mietpreis/);
      expect(entry.editorNote, path).toMatch(/Inklusivleistungen/);
      expect(entry.editorNote, path).toMatch(/Transport/);
    }
  });

  it('Regionsseiten: eigener Text je Ort (keine Ortsnamen-Schablone) und Notiz „vor Veröffentlichung lokal prüfen“', () => {
    const regions = pages.filter((entry) => entry.pageType === 'region');
    expect(regions.map((entry) => entry.path).sort()).toEqual(
      Object.keys(REGION_PLACE_NAMES).sort(),
    );
    const normalized = regions.map((entry) => {
      const place = REGION_PLACE_NAMES[entry.path] ?? '';
      expect(entry.editorNote, entry.path).toContain('vor Veröffentlichung lokal prüfen');
      expect(entry.content.title, entry.path).toContain(place);
      // Seitentitel und Meta-Titel dürfen dem Suchbegriff folgen („Slushmaschine mieten in …“);
      // alle sichtbaren Blocktexte und die Meta-Beschreibung müssen je Ort eigenständig sein.
      return new Set(
        [...collectCmsStrings(entry.content.blocks), entry.metaDescription ?? '']
          .map((text) => text.split(place).join('{ort}'))
          .filter((text) => text.length >= 25),
      );
    });
    for (let i = 0; i < normalized.length; i += 1) {
      for (let j = i + 1; j < normalized.length; j += 1) {
        const shared = [...normalized[i]!].filter((text) => normalized[j]!.has(text));
        expect(shared, `${regions[i]!.path} ↔ ${regions[j]!.path}`).toEqual([]);
      }
    }
    const layouts = regions.map((entry) => entry.content.blocks.map((b) => b.type).join(','));
    expect(new Set(layouts).size).toBe(regions.length);
  });

  it('Redaktionsnotizen sind interner reiner Text (≤ 2000 Zeichen wie CMS_EDITOR_NOTE_MAX)', () => {
    for (const entry of CMS_BOOTSTRAP_ENTRIES) {
      const note = entry.editorNote;
      expect(note, targetOf(entry)).toBeDefined();
      if (note === undefined) continue;
      expect(note.length, targetOf(entry)).toBeLessThanOrEqual(2000);
      expect(note.trim(), targetOf(entry)).toBe(note);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(note), targetOf(entry)).toBe(false);
      expect(/<\s*[a-zA-Z/!?]/.test(note), targetOf(entry)).toBe(false);
    }
  });
});
