/**
 * Phase 17 (WEB-META, Design D10, Auftrag §13/§29): konservative strukturierte Daten (JSON-LD).
 *
 * Nur auf indexierbaren Seiten mit gültiger Basis (die Aufrufer entscheiden):
 * - Startseite: `WebSite` + `Organization` – ausschließlich tatsächlich veröffentlichte Daten
 *   (Name, URL; Logo nur mit eigener veröffentlichter Medien-URL; Telefon nur gepflegt und in
 *   internationaler E.164-Form; E-Mail nur gepflegt; Instagram nur als gültiger Link).
 *   KEINE Adresse (der exakte Abholort bleibt geheim ⇒ kein LocalBusiness), keine
 *   Öffnungszeiten, keine Preisspannen, kein AggregateRating/Review (Bewertungen werden erst
 *   nach Nutzeraktion geladen), kein Product/Offer, keine FAQPage.
 * - Regions-/Secondary-Offer-Seiten: `BreadcrumbList` exakt wie die sichtbare Brotkrume.
 * Nichts auf Vorschau/Portal/Token/404/410/Fallback. Reine Funktionen (node --test).
 */
import { phoneHref } from './site-format.ts';
import { safeInstagramUrl, type BreadcrumbItem } from './site-nav.ts';
import { canonicalUrl, seoImageFrom } from './site-seo.ts';
import type { PublicSiteSettings } from './site-types.ts';

export const SCHEMA_CONTEXT = 'https://schema.org';

export interface JsonLdObject {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': string;
  [key: string]: unknown;
}

/** `WebSite` der Startseite (keine SearchAction – es gibt keine Website-Suche). */
export function websiteJsonLd(input: { base: string; name: string }): JsonLdObject {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'WebSite',
    name: input.name,
    url: `${input.base}/`,
    inLanguage: 'de',
  };
}

/**
 * Telefonnummer für `Organization.telephone`: Wählform aus `phoneHref` (ohne `tel:`), nur in
 * internationaler Schreibweise (`+49…`; `00…` wird zu `+`). Nationale Schreibweisen ohne
 * Ländervorwahl entfallen (Google empfiehlt Landes- und Ortsvorwahl) – die Seite zeigt die
 * Nummer weiterhin an.
 */
export function organizationTelephone(phone: string | null | undefined): string | null {
  const text = (phone ?? '').trim();
  if (text === '') return null;
  const href = phoneHref(text);
  if (href === null) return null;
  const digits = href.slice('tel:'.length);
  const international = digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
  return international.startsWith('+') ? international : null;
}

/** E-Mail nur in plausibler Form (wie der `mailto:`-Filter der CMS-Links). */
export function organizationEmail(email: string | null | undefined): string | null {
  const text = (email ?? '').trim();
  return /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(text) ? text : null;
}

/** `Organization` aus den veröffentlichten Website-Einstellungen – nur vorhandene Felder. */
export function organizationJsonLd(input: {
  base: string;
  settings: PublicSiteSettings;
}): JsonLdObject {
  const { base, settings } = input;
  const logo = settings.logo === null ? null : seoImageFrom(settings.logo, base);
  const telephone = organizationTelephone(settings.phone);
  const email = organizationEmail(settings.email);
  const instagram = safeInstagramUrl(settings.instagramUrl);
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Organization',
    name: settings.businessName,
    url: `${base}/`,
    ...(logo === null ? {} : { logo: logo.url }),
    ...(telephone === null ? {} : { telephone }),
    ...(email === null ? {} : { email }),
    ...(instagram === null ? {} : { sameAs: [instagram] }),
  };
}

/**
 * `BreadcrumbList`: Positionen ab 1; das letzte Element (die aktuelle Seite) ohne `item`
 * (Google: optional für die letzte Position).
 */
export function breadcrumbJsonLd(
  items: ReadonlyArray<{ name: string; url?: string | undefined }>,
): JsonLdObject {
  const last = items.length - 1;
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(index < last && item.url !== undefined ? { item: item.url } : {}),
    })),
  };
}

/** Sichtbare Brotkrume ⇒ `BreadcrumbList` mit absoluten URLs (JSON-LD = sichtbare Navigation). */
export function breadcrumbListJsonLd(items: readonly BreadcrumbItem[], base: string): JsonLdObject {
  return breadcrumbJsonLd(
    items.map((item) => ({ name: item.name, url: canonicalUrl(base, item.href) })),
  );
}

/**
 * JSON für `<script type="application/ld+json">`: `<`, `>` und `&` als Unicode-Escapes, damit
 * kein Inhalt (z. B. `</script>`) das Script-Element beenden oder HTML einschleusen kann.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
