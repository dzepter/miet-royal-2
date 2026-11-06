import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  GOOGLE_ATTRIBUTION,
  GOOGLE_POLICY_URI,
  REVIEWS_TEXT,
  acceptReviewsResponse,
  attributionText,
  displayableReviews,
  effectiveReviewsMode,
  fetchReviews,
  originalTextOf,
  reviewsPolicyNotice,
  translationLabel,
} from './reviews.ts';
import type { PublicReview, PublicReviewsResponse } from './site-types.ts';

/**
 * Phase 16 Review-Fixes (WEB, Order §18/§21, Design §4/§11.2.6): Google-Pflichtangaben
 * (Richtlinienhinweis + Link, Übersetzungshinweis, Originaltext, „Google Maps“ mit
 * translate="no"/nowrap – demo_reviews-1/-4) und fail-closed bei Modus-/Origin-Abweichung
 * (demo_reviews-2, web_security-1). Läuft mit `node --test`.
 */

const SECTION_SOURCE = readFileSync(
  new URL('../components/site/reviews-section.tsx', import.meta.url),
  'utf8',
);
const SITE_CSS = readFileSync(
  new URL('../components/site/site.module.css', import.meta.url),
  'utf8',
);

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

  it('W-R9. Attribution: Google immer exakt „Google Maps“ (translate="no", nowrap); Demo nie „Google“', () => {
    assert.equal(attributionText(GOOGLE), GOOGLE_ATTRIBUTION);
    assert.equal(attributionText({ ...GOOGLE, attribution: 'Irgendwas' }), 'Google Maps');
    assert.equal(attributionText({ ...GOOGLE, attribution: '' }), 'Google Maps');
    assert.doesNotMatch(attributionText(DEMO), /google/i);
    assert.doesNotMatch(attributionText({ ...DEMO, attribution: 'Google Maps' }), /google/i);

    // Darstellung: „Google Maps“ in einem eigenen Element mit translate="no" und nowrap-Klasse.
    assert.match(
      SECTION_SOURCE,
      /<span translate="no" className=\{styles\.noWrap\}[^>]*>\s*Google Maps\s*<\/span>/,
    );
    assert.match(SECTION_SOURCE, /Quelle: \{google \? <GoogleMapsName/);
    assert.match(SITE_CSS, /\.noWrap \{\s*white-space: nowrap;\s*\}/);
    // Richtlinien-Link extern sicher geöffnet.
    assert.match(
      SECTION_SOURCE,
      /<a href=\{policy\.href\} rel="noopener noreferrer" target="_blank">/,
    );
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
