import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decideLegacyRoute } from './legacy-routes.ts';
import {
  GOOGLE_ATTRIBUTION,
  GOOGLE_MAPS_LOGO,
  GOOGLE_POLICY_URI,
  REVIEWS_TEXT,
  acceptReviewsResponse,
  attributionText,
  displayableReviews,
  effectiveReviewsMode,
  fetchReviews,
  originalTextOf,
  reviewsAttribution,
  reviewsPolicyNotice,
  translationLabel,
} from './reviews.ts';
import type { PublicReview, PublicReviewsResponse } from './site-types.ts';

/**
 * Phase 16 Review-Fixes (WEB, Order §18/§21, Design §4/§11.2.6): Google-Pflichtangaben
 * (Richtlinienhinweis + Link, Übersetzungshinweis, Originaltext, „Google Maps“ mit
 * translate="no"/nowrap – demo_reviews-1/-4) und fail-closed bei Modus-/Origin-Abweichung
 * (demo_reviews-2, web_security-1). Phase 17 (REVIEWS-QA, Design D19 / Auftrag §25): Attribution
 * mit dem offiziellen Google-Maps-Logo (SEO-W-REV1–SEO-W-REV3). Läuft mit `node --test`.
 */

const SECTION_SOURCE = readFileSync(
  new URL('../components/site/reviews-section.tsx', import.meta.url),
  'utf8',
);
const SITE_CSS = readFileSync(
  new URL('../components/site/site.module.css', import.meta.url),
  'utf8',
);
const LOGO_SVG = readFileSync(new URL('../public/google-maps-logo-gray.svg', import.meta.url));

/**
 * SHA-256 des offiziellen Assets `GoogleMaps_Logo_Gray.svg` aus
 * https://developers.google.com/static/maps/documentation/images/Google_Maps_Attribution_Assets.zip
 * (Zip 2025-07-08, geprüft 12.11.2026). POL: „Use the official Google Maps logo files. Don't
 * modify the logo in any way.“ – jede Änderung der Datei (auch „Optimierung“) bricht diesen Test.
 */
const OFFICIAL_LOGO_SHA256 = '99a08b570afce8ce830d26aeb93ba287f6ad67387e6219fe381234ad7e4016b5';

const TRANSLATED: PublicReview = {
  authorName: 'B. Beispiel',
  authorUri: 'https://www.google.com/maps/contrib/2',
  authorPhotoUri: 'https://lh3.googleusercontent.com/a/2',
  rating: 5,
  text: 'Tolle Maschine, alles hat geklappt!',
  translated: true,
  originalText: 'Great machine, everything worked!',
  relativeTime: 'vor zwei Wochen',
  publishTime: null,
  reviewUri: 'https://www.google.com/maps/reviews/2',
  flagUri: null,
};

const GOOGLE: PublicReviewsResponse = {
  mode: 'google',
  rating: 4.8,
  total: 37,
  placeUri: 'https://maps.google.com/?cid=1',
  attribution: 'Google Maps',
  sortNote: 'Bis zu 5 Bewertungen von Google Maps …',
  translationNote: 'Von Google übersetzt',
  policyNote:
    'Google prüft Bewertungen nicht, sucht aber nach gefälschten Inhalten und entfernt sie, sobald sie erkannt werden.',
  policyUri: 'https://support.google.com/contributionpolicy/answer/7422880',
  reviews: [TRANSLATED],
};

const DEMO: PublicReviewsResponse = {
  mode: 'demo',
  rating: null,
  total: null,
  placeUri: null,
  attribution: 'DEMO – synthetische Beispielbewertungen',
  sortNote: 'Feste Beispieltexte der DEMO-Umgebung – keine echten Bewertungen.',
  translationNote: null,
  policyNote: null,
  policyUri: null,
  reviews: [
    {
      ...TRANSLATED,
      authorName: 'Demo-Kundin A.',
      text: 'DEMO-Beispieltext: super Slush!',
      authorUri: null,
      authorPhotoUri: null,
      reviewUri: null,
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** WCAG 2.x relative Leuchtdichte / Kontrastverhältnis (#rrggbb). */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(SITE_CSS);
  assert.ok(match, `Token --${name}`);
  return match[1]!.toLowerCase();
}

describe('Bewertungen – Google-Pflichtangaben (Review demo_reviews-1/-4)', () => {
  it('W-R6. Google: Richtlinienhinweis + https-Link aus der API; Demo ⇒ kein Hinweis (nie „Google“)', () => {
    assert.deepEqual(reviewsPolicyNotice(GOOGLE), {
      text: GOOGLE.policyNote,
      href: 'https://support.google.com/contributionpolicy/answer/7422880',
    });
    assert.equal(reviewsPolicyNotice(DEMO), null);
    assert.equal(reviewsPolicyNotice({ ...DEMO, policyNote: 'Google …' }), null);
  });

  it('W-R7. Google ohne/mit ungültigen Richtlinienfeldern ⇒ lokaler Fallback – der Hinweis fehlt nie', () => {
    const legacy: PublicReviewsResponse = { ...GOOGLE };
    delete legacy.policyNote;
    delete legacy.policyUri;
    for (const response of [
      legacy,
      { ...GOOGLE, policyNote: null, policyUri: null },
      { ...GOOGLE, policyNote: '   ', policyUri: 'http://support.google.com/x' },
      { ...GOOGLE, policyNote: 42 as unknown as string, policyUri: 'javascript:alert(1)' },
    ]) {
      const notice = reviewsPolicyNotice(response);
      assert.deepEqual(notice, { text: REVIEWS_TEXT.POLICY_NOTE, href: GOOGLE_POLICY_URI });
    }
    assert.match(GOOGLE_POLICY_URI, /^https:\/\/support\.google\.com\/contributionpolicy\//);
  });

  it('W-R8. Übersetzung: translationNote der API, Fallback „Von Google übersetzt“; Originaltext nur bei übersetzten Google-Bewertungen', () => {
    assert.equal(translationLabel(GOOGLE), 'Von Google übersetzt');
    assert.equal(
      translationLabel({ ...GOOGLE, translationNote: 'Übersetzt von Google' }),
      'Übersetzt von Google',
    );
    assert.equal(translationLabel({ ...GOOGLE, translationNote: null }), REVIEWS_TEXT.TRANSLATED);
    assert.equal(translationLabel(DEMO), null);

    assert.equal(originalTextOf(GOOGLE, TRANSLATED), 'Great machine, everything worked!');
    assert.equal(originalTextOf(GOOGLE, { ...TRANSLATED, translated: false }), null);
    assert.equal(originalTextOf(GOOGLE, { ...TRANSLATED, originalText: null }), null);
    assert.equal(originalTextOf(GOOGLE, { ...TRANSLATED, originalText: ' ' }), null);
    assert.equal(originalTextOf(GOOGLE, { ...TRANSLATED, originalText: TRANSLATED.text }), null);
    assert.equal(originalTextOf(DEMO, DEMO.reviews[0]!), null);
    // Demo-Bewertungen tragen nie Übersetzungs-/Originalangaben.
    const demoShown = displayableReviews(DEMO);
    assert.equal(demoShown[0]?.translated, false);
    assert.equal(demoShown[0]?.originalText, null);
  });

  it('W-R9. Attribution: Google immer exakt „Google Maps“ (Label des Logos, Linktexte mit translate="no"/nowrap); Demo nie „Google“', () => {
    assert.equal(attributionText(GOOGLE), GOOGLE_ATTRIBUTION);
    assert.equal(attributionText({ ...GOOGLE, attribution: 'Irgendwas' }), 'Google Maps');
    assert.equal(attributionText({ ...GOOGLE, attribution: '' }), 'Google Maps');
    assert.doesNotMatch(attributionText(DEMO), /google/i);
    assert.doesNotMatch(attributionText({ ...DEMO, attribution: 'Google Maps' }), /google/i);

    // Darstellung: „Google Maps“ in Linktexten in einem eigenen Element mit translate="no" und
    // nowrap-Klasse („Alle Bewertungen auf Google Maps“, „Auf Google Maps ansehen“).
    assert.match(
      SECTION_SOURCE,
      /<span translate="no" className=\{styles\.noWrap\}[^>]*>\s*Google Maps\s*<\/span>/,
    );
    assert.match(SECTION_SOURCE, /Alle Bewertungen auf <GoogleMapsName \/>/);
    assert.match(SECTION_SOURCE, /Auf <GoogleMapsName \/> ansehen/);
    assert.match(SITE_CSS, /\.noWrap \{\s*white-space: nowrap;\s*\}/);
    // Die sichtbare Textattribution gibt es nur noch im Demo-Zweig (Phase 17: Google ⇒ Logo).
    assert.match(SECTION_SOURCE, /Quelle: \{attribution\.text\}/);
    assert.doesNotMatch(SECTION_SOURCE, /Quelle: \{google/);
    // Richtlinien-Link extern sicher geöffnet.
    assert.match(
      SECTION_SOURCE,
      /<a href=\{policy\.href\} rel="noopener noreferrer" target="_blank">/,
    );
  });
});

describe('Bewertungen – Attribution mit dem offiziellen Google-Maps-Logo (Phase 17, Design D19 / Auftrag §25)', () => {
  it('SEO-W-REV1. google ⇒ Logo-Attribution mit alt „Google Maps“ (verlinkt nur auf https-placeUri); demo ⇒ Text ohne Logo, nie „Google“', () => {
    assert.deepEqual(reviewsAttribution(GOOGLE), {
      kind: 'google-maps-logo',
      src: '/google-maps-logo-gray.svg',
      alt: 'Google Maps',
      width: 98,
      height: 18,
      href: 'https://maps.google.com/?cid=1',
    });
    // placeUri fehlt oder ist nicht https ⇒ Logo ohne Link (nie http/javascript verlinken).
    for (const placeUri of [null, '', 'http://maps.google.com/?cid=1', 'javascript:alert(1)']) {
      const attribution = reviewsAttribution({ ...GOOGLE, placeUri });
      assert.equal(attribution.kind, 'google-maps-logo');
      assert.equal(attribution.kind === 'google-maps-logo' ? attribution.href : 'x', null);
    }
    // Auch eine abweichende API-Attribution ändert im Google-Modus nichts am Logo.
    assert.equal(
      reviewsAttribution({ ...GOOGLE, attribution: 'Irgendwas' }).kind,
      'google-maps-logo',
    );

    assert.deepEqual(reviewsAttribution(DEMO), {
      kind: 'text',
      text: 'DEMO – synthetische Beispielbewertungen',
    });
    assert.deepEqual(reviewsAttribution({ ...DEMO, attribution: 'Google Maps' }), {
      kind: 'text',
      text: 'DEMO – synthetische Beispielbewertungen',
    });
    const demoWithPlace = reviewsAttribution({
      ...DEMO,
      placeUri: 'https://maps.google.com/?cid=1',
    });
    assert.equal(demoWithPlace.kind, 'text');
    assert.doesNotMatch(JSON.stringify(demoWithPlace), /google|logo|svg/i);

    // Asset-Konstanten: natives Verhältnis 98:18, alt = Pflichttext, Freiraum ≥ 10 px (POL) und
    // Linkfläche 18 + 2 × Freiraum ≥ 44 px (UX_RULES).
    assert.equal(GOOGLE_MAPS_LOGO.alt, GOOGLE_ATTRIBUTION);
    assert.equal(GOOGLE_MAPS_LOGO.width / GOOGLE_MAPS_LOGO.height, 98 / 18);
    assert.ok(GOOGLE_MAPS_LOGO.height >= 16 && GOOGLE_MAPS_LOGO.height <= 19);
    assert.ok(GOOGLE_MAPS_LOGO.clearSpacePx >= 10);
    assert.ok(GOOGLE_MAPS_LOGO.height + 2 * GOOGLE_MAPS_LOGO.clearSpacePx >= 44);

    // Darstellung (Quelltext der Komponente): <img src alt width height>, CSS-Höhe 18 px/Breite
    // auto, translate="no" + Test-IDs am umgebenden Element, nur im Logo-Zweig gerendert.
    assert.match(
      SECTION_SOURCE,
      /<img\s+src=\{attribution\.src\}\s+alt=\{attribution\.alt\}\s+width=\{attribution\.width\}\s+height=\{attribution\.height\}/,
    );
    assert.match(SECTION_SOURCE, /height: `\$\{attribution\.height\}px`, width: 'auto'/);
    assert.match(
      SECTION_SOURCE,
      /<div\s+translate="no"\s+data-testid="reviews-attribution"\s+data-attribution="google-maps-logo"/,
    );
    assert.match(SECTION_SOURCE, /padding: `\$\{GOOGLE_MAPS_LOGO\.clearSpacePx\}px 0`/);
    assert.match(
      SECTION_SOURCE,
      /attribution\.kind === 'google-maps-logo' \? \(\s*<GoogleMapsAttribution attribution=\{attribution\} \/>/,
    );
    assert.equal(SECTION_SOURCE.match(/<GoogleMapsAttribution /g)?.length, 1);
    // Logo-Link extern sicher geöffnet; ohne placeUri ein Span statt Link.
    assert.match(
      SECTION_SOURCE,
      /<a href=\{attribution\.href\} rel="noopener noreferrer" target="_blank" style=\{clearSpace\}>/,
    );
    assert.match(SECTION_SOURCE, /<span style=\{clearSpace\}>\{logo\}<\/span>/);
    // Demo-Zweig: Textattribution mit Test-ID, kein Logo-Pfad außerhalb des Logo-Zweigs.
    assert.match(
      SECTION_SOURCE,
      /data-testid="reviews-attribution"\s+data-attribution="text"\s*>\s*Quelle: \{attribution\.text\}/,
    );
    assert.doesNotMatch(SECTION_SOURCE, /google-maps-logo-gray\.svg/);
    // Horizontaler Freiraum: Flex-Abstand der Summary-Zeile ≥ 10 px und Seitenrand ≥ 1rem.
    assert.match(SITE_CSS, /\.reviewSummary \{[^}]*gap: 0\.5rem 1rem;/);
    assert.match(SITE_CSS, /--mr-gutter: clamp\(1rem, 4vw, 2rem\);/);
    // Kontrast Gray #5E5E5E auf dem Creme-Hintergrund der Sektion (POL „accessible contrast“).
    assert.ok(contrast('#5e5e5e', token('mr-cream')) >= 4.5);
    assert.ok(contrast('#5e5e5e', token('mr-sand')) >= 4.5);
  });

  it('SEO-W-REV2. Asset in apps/web/public ist die unveränderte offizielle Gray-SVG (Hash, 98×18, nur Pfade – kein Script, keine externen Referenzen)', () => {
    assert.equal(createHash('sha256').update(LOGO_SVG).digest('hex'), OFFICIAL_LOGO_SHA256);
    const svg = LOGO_SVG.toString('utf8');
    assert.match(svg, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
    assert.match(svg, /<svg [^>]*width="98px" height="18px" viewBox="0 0 98 18"/);
    assert.equal(svg.match(/<path /g)?.length, 2);
    assert.deepEqual([...new Set(svg.match(/fill="#[0-9A-Fa-f]{6}"/g))], ['fill="#5E5E5E"']);
    for (const forbidden of [
      /<script/i,
      /<style/i,
      /<image/i,
      /<use\b/i,
      /<foreignObject/i,
      /<!ENTITY/i,
      /<!DOCTYPE/i,
      /\shref=/i,
      /xlink:href/i,
      /url\(/i,
      /@import/i,
      /javascript:/i,
      /\son[a-z]+=/i,
    ]) {
      assert.doesNotMatch(svg, forbidden);
    }
    // Einzige externe Zeichenketten: die SVG-/XLink-Namensraum-Deklarationen (keine Referenzen).
    const urls = svg.match(/https?:\/\/[^"'\s<>]+/g) ?? [];
    assert.deepEqual([...new Set(urls)].sort(), [
      'http://www.w3.org/1999/xlink',
      'http://www.w3.org/2000/svg',
    ]);
  });

  it('SEO-W-REV3. Proxy (Alt-URL-Behandlung) lässt den Logo-Pfad unberührt – kein Redirect, kein 410 ⇒ Datei aus public/', () => {
    assert.deepEqual(decideLegacyRoute(GOOGLE_MAPS_LOGO.src, ''), { kind: 'none' });
    assert.deepEqual(decideLegacyRoute(GOOGLE_MAPS_LOGO.src, '?v=1'), { kind: 'none' });
    assert.equal(GOOGLE_MAPS_LOGO.src.endsWith('/'), false);
    assert.match(GOOGLE_MAPS_LOGO.src, /^\/[a-z0-9-]+\.svg$/);
  });
});

describe('Bewertungen – fail-closed bei Umgebungs-Abweichung (Review demo_reviews-2 / web_security-1)', () => {
  it('W-R10. Antwort mit anderem Modus als der SSR-Modus wird verworfen (beide Richtungen)', () => {
    assert.equal(acceptReviewsResponse('demo', { mode: 'google' }), false);
    assert.equal(acceptReviewsResponse('google', { mode: 'demo' }), false);
    assert.equal(acceptReviewsResponse('disabled', { mode: 'demo' }), false);
    assert.equal(acceptReviewsResponse('disabled', { mode: 'google' }), false);
    assert.equal(acceptReviewsResponse('demo', { mode: 'demo' }), true);
    assert.equal(acceptReviewsResponse('google', { mode: 'google' }), true);
  });

  it('W-R11. fetchReviews(expectedMode): Demo-Seite + Google-Antwort bzw. Live-Seite + Demo-Antwort ⇒ „nicht verfügbar“', async () => {
    assert.deepEqual(await fetchReviews('demo', async () => json(GOOGLE)), {
      kind: 'unavailable',
    });
    assert.deepEqual(await fetchReviews('google', async () => json(DEMO)), {
      kind: 'unavailable',
    });
    assert.deepEqual(await fetchReviews('disabled', async () => json(DEMO)), {
      kind: 'unavailable',
    });
    assert.deepEqual(await fetchReviews('demo', async () => json(DEMO)), {
      kind: 'ok',
      data: DEMO,
    });
    assert.deepEqual(await fetchReviews('google', async () => json(GOOGLE)), {
      kind: 'ok',
      data: GOOGLE,
    });
    assert.equal(REVIEWS_TEXT.UNAVAILABLE, 'Bewertungen sind gerade nicht verfügbar.');
  });

  it('W-R12. Build-/Laufzeit-Origin-Abweichung ⇒ Sektion wie disabled; unbekannte Modi ⇒ disabled', () => {
    assert.equal(effectiveReviewsMode('google', true), 'disabled');
    assert.equal(effectiveReviewsMode('demo', true), 'disabled');
    assert.equal(effectiveReviewsMode('google', false), 'google');
    assert.equal(effectiveReviewsMode('demo', false), 'demo');
    assert.equal(effectiveReviewsMode('disabled', false), 'disabled');
    assert.equal(effectiveReviewsMode('fake', false), 'disabled');
    assert.equal(effectiveReviewsMode(undefined, false), 'disabled');
    assert.equal(effectiveReviewsMode(null, false), 'disabled');
  });
});

describe('Fokus im CTA-Band (Review content_ux-3, WCAG 2.1 SC 1.4.11)', () => {
  it('W-A11Y1. .ctaBand :focus-visible nutzt Gold; Kontrast Fokusrahmen/Hintergrund ≥ 3:1 (vorher Bronze 2,66:1)', () => {
    const rule = /\.ctaBand :focus-visible \{\s*outline-color: var\(--([a-z-]+)\);\s*\}/.exec(
      SITE_CSS,
    );
    assert.ok(rule, '.ctaBand :focus-visible-Regel');
    const ctaBackground = /\.ctaBand \{[^}]*background: var\(--([a-z-]+)\)/.exec(SITE_CSS);
    assert.ok(ctaBackground, '.ctaBand-Hintergrund');
    const ratio = contrast(token(rule[1]!), token(ctaBackground[1]!));
    assert.equal(rule[1], 'mr-gold-light');
    assert.ok(ratio >= 3, `Kontrast ${ratio.toFixed(2)}:1`);
    assert.equal(Math.round(ratio * 100) / 100, 10.46);
    // Gegenprobe: der globale Bronze-Fokus hätte auf dem dunklen Band nur 2,66:1.
    assert.equal(Math.round(contrast(token('mr-focus'), token('mr-ink')) * 100) / 100, 2.66);
    // Regel steht NACH der globalen `.site :focus-visible` (gleiche Spezifität ⇒ gewinnt).
    assert.ok(
      SITE_CSS.indexOf('.ctaBand :focus-visible') > SITE_CSS.indexOf('.site :focus-visible'),
    );
  });
});
