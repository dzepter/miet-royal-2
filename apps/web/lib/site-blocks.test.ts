import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  REVIEWS_TEXT,
  attributionText,
  displayableReviews,
  fetchReviews,
  isReviewsResponse,
  reviewsNotice,
  reviewsSectionVisible,
  safeHttpsUrl,
} from './reviews.ts';
import {
  SITE_BLOCK_LABELS,
  hasContactDetails,
  imageDefaultSrc,
  imageSrcSet,
  isOwnMediaUrl,
  isSiteBlockType,
  pageUsesHeroHeading,
  visibleBlocks,
  type BlockVisibilityContext,
} from './site-blocks.ts';
import {
  SITE_BLOCK_TYPES,
  SITE_PAGE_TYPES,
  type PublicBlock,
  type PublicReviewsResponse,
} from './site-types.ts';

/**
 * Phase 16 (WEB, Design §5 „Renderer“, §11.3 „WEB“): Block-Typen-Abdeckung (Spiegel von
 * `CMS_BLOCK_TYPES` aus `packages/validation/src/cms.ts`), Sichtbarkeit einzelner Blöcke,
 * Bildvarianten und die Bewertungs-Logik (Klick-zum-Laden, Demo nie „Google“).
 */

const VALIDATION_SOURCE = readFileSync(
  new URL('../../../packages/validation/src/cms.ts', import.meta.url),
  'utf8',
);

function literalsFromSource(): string[] {
  return [...VALIDATION_SOURCE.matchAll(/type: z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1]!);
}

const CTX: BlockVisibilityContext = {
  reviewsMode: 'disabled',
  pages: [],
  settings: null,
};

const IMAGE = {
  mediaId: '2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f',
  alt: 'Slushmaschine',
  decorative: false,
  width: 1600,
  height: 1067,
  variants: [
    { width: 1600, url: '/api/public/cms/media/2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f/1600' },
    { width: 480, url: '/api/public/cms/media/2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f/480' },
    { width: 960, url: '/api/public/cms/media/2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f/960' },
  ],
};

describe('Block-Renderer (Phase 16)', () => {
  it('W-B1. SITE_BLOCK_TYPES spiegelt CMS_BLOCK_TYPES exakt (Quelle: packages/validation/src/cms.ts)', () => {
    assert.deepEqual([...SITE_BLOCK_TYPES], literalsFromSource());
    assert.equal(SITE_BLOCK_TYPES.length, 14);
    for (const type of SITE_BLOCK_TYPES) {
      assert.equal(typeof SITE_BLOCK_LABELS[type], 'string', `Label für ${type}`);
      assert.equal(isSiteBlockType(type), true);
    }
    assert.deepEqual(Object.keys(SITE_BLOCK_LABELS).sort(), [...SITE_BLOCK_TYPES].sort());
    assert.equal(isSiteBlockType('html'), false);
  });

  it('W-B2. Seitentypen spiegeln CMS_PAGE_TYPES', () => {
    const match = /export const CMS_PAGE_TYPES = \[([\s\S]*?)\] as const/.exec(VALIDATION_SOURCE);
    const types = [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...SITE_PAGE_TYPES], types);
  });

  it('W-B3. Sichtbarkeit: unbekannte Typen ignoriert, Bewertungen nur mit Provider, sekundäre Angebote nur veröffentlicht, leere Listen weg', () => {
    const blocks = [
      { type: 'text', body: 'Hallo' },
      { type: 'html', body: '<script>' },
      { type: 'reviews', heading: 'Stimmen' },
      { type: 'secondary_offers' },
      { type: 'product_grid', products: [] },
      { type: 'gallery', images: [] },
      { type: 'contact_details' },
    ] as unknown as PublicBlock[];
    assert.deepEqual(
      visibleBlocks(blocks, CTX).map((block) => block.type),
      ['text', 'contact_details'],
    );
    assert.deepEqual(
      visibleBlocks(blocks, {
        reviewsMode: 'demo',
        pages: [
          {
            path: '/popcornmaschine-mieten',
            pageType: 'secondary_offer',
            title: 'Popcorn',
            metaDescription: null,
          },
        ],
        settings: null,
      }).map((block) => block.type),
      ['text', 'reviews', 'secondary_offers', 'contact_details'],
    );
    assert.equal(
      visibleBlocks(blocks, { ...CTX, reviewsMode: 'google' }).some((b) => b.type === 'reviews'),
      true,
    );
  });

  it('W-B4. H1-Regel: Hero am Anfang liefert die H1, sonst der Seitentitel', () => {
    assert.equal(pageUsesHeroHeading([{ type: 'hero', heading: 'Slush!' }]), true);
    assert.equal(pageUsesHeroHeading([{ type: 'text', body: 'x' }]), false);
    assert.equal(pageUsesHeroHeading([]), false);
  });

  it('W-B5. Bilder: srcSet aufsteigend, Standard ≈ 960 px, nur eigene opake Medienrouten', () => {
    assert.equal(
      imageSrcSet(IMAGE.variants),
      `${IMAGE.variants[1]!.url} 480w, ${IMAGE.variants[2]!.url} 960w, ${IMAGE.variants[0]!.url} 1600w`,
    );
    assert.equal(imageDefaultSrc(IMAGE.variants), IMAGE.variants[2]!.url);
    assert.equal(imageDefaultSrc([{ width: 1600, url: 'a' }]), 'a');
    assert.equal(imageDefaultSrc([]), null);
    assert.equal(isOwnMediaUrl(IMAGE.variants[0]!.url), true);
    assert.equal(
      isOwnMediaUrl('/api/public/cms/preview-media/2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f/480'),
      true,
    );
    assert.equal(isOwnMediaUrl('https://cdn.example/x.webp'), false);
    assert.equal(isOwnMediaUrl('/api/public/cms/media/../../staff/1/480'), false);
    assert.equal(
      isOwnMediaUrl('/api/staff/cms/media/2b7c9a7e-3a1f-4c55-9f0e-1a2b3c4d5e6f/480'),
      false,
    );
  });

  it('W-B6. Kontaktblock nur mit gepflegten Werten aus den Einstellungen', () => {
    const settings = {
      businessName: 'Miet-Royal',
      tagline: null,
      phone: null,
      email: null,
      instagramUrl: null,
      logo: null,
      footerNote: null,
    };
    assert.equal(hasContactDetails(null), false);
    assert.equal(hasContactDetails(settings), false);
    assert.equal(hasContactDetails({ ...settings, email: 'info@example.org' }), true);
  });
});

describe('Bewertungen – Klick-zum-Laden (Phase 16)', () => {
  const GOOGLE: PublicReviewsResponse = {
    mode: 'google',
    rating: 4.8,
    total: 31,
    placeUri: 'https://maps.google.com/?cid=1',
    attribution: 'Google Maps',
    sortNote: 'Sortiert nach Relevanz (Google).',
    reviews: [
      {
        authorName: 'A. Beispiel',
        authorUri: 'https://www.google.com/maps/contrib/1',
        authorPhotoUri: 'https://lh3.googleusercontent.com/a/1',
        rating: 5,
        text: 'Super!',
        translated: false,
        relativeTime: 'vor einer Woche',
        publishTime: null,
        reviewUri: 'https://www.google.com/maps/reviews/1',
        flagUri: 'https://www.google.com/local/review/rap/report?x',
      },
      {
        authorName: 'Ohne Foto',
        authorUri: 'https://www.google.com/maps/contrib/2',
        authorPhotoUri: null,
        rating: 4,
        text: 'Gut',
        relativeTime: null,
        publishTime: null,
        reviewUri: null,
        flagUri: null,
      },
    ],
  };

  it('W-R1. Sektion nur mit aktivem Provider; Hinweistexte je Modus (Demo eindeutig, nie „Google“)', () => {
    assert.equal(reviewsSectionVisible('disabled'), false);
    assert.equal(reviewsSectionVisible(undefined), false);
    assert.equal(reviewsSectionVisible('google'), true);
    assert.equal(reviewsSectionVisible('demo'), true);
    assert.equal(reviewsNotice('google'), REVIEWS_TEXT.GOOGLE_NOTICE);
    assert.match(reviewsNotice('demo'), /DEMO/);
    assert.doesNotMatch(reviewsNotice('demo'), /google/i);
  });

  it('W-R2. Google: nur Bewertungen mit Pflicht-Attribution (Autor-Link + Profilbild https)', () => {
    const shown = displayableReviews(GOOGLE);
    assert.deepEqual(
      shown.map((review) => review.authorName),
      ['A. Beispiel'],
    );
    assert.equal(attributionText(GOOGLE), 'Google Maps');
  });

  it('W-R3. Demo: Links/Fotos entfernt, Attribution nie „Google“', () => {
    const demo: PublicReviewsResponse = {
      ...GOOGLE,
      mode: 'demo',
      attribution: 'Google Maps',
      placeUri: null,
    };
    const shown = displayableReviews(demo);
    assert.equal(shown.length, 2);
    assert.ok(shown.every((review) => review.authorPhotoUri === null && review.authorUri === null));
    assert.equal(attributionText(demo), 'DEMO – synthetische Beispielbewertungen');
    assert.equal(
      attributionText({ ...demo, attribution: 'DEMO – synthetische Beispielbewertungen' }),
      'DEMO – synthetische Beispielbewertungen',
    );
  });

  it('W-R4. Laden: GET /api/public/reviews no-store; 404/503/Formfehler/Netz ⇒ „nicht verfügbar“', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = await fetchReviews(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(GOOGLE), { status: 200 });
    });
    assert.equal(ok.kind, 'ok');
    assert.equal(calls[0]?.url, '/api/public/reviews');
    assert.equal(calls[0]?.init.method, 'GET');
    assert.equal(calls[0]?.init.cache, 'no-store');
    for (const response of [
      new Response('{}', { status: 404 }),
      new Response('{"error":{"code":"REVIEWS_UNAVAILABLE"}}', { status: 503 }),
      new Response('{"mode":"google"}', { status: 200 }),
    ]) {
      assert.deepEqual(await fetchReviews(async () => response), { kind: 'unavailable' });
    }
    assert.deepEqual(
      await fetchReviews(async () => {
        throw new Error('offline');
      }),
      { kind: 'unavailable' },
    );
    assert.equal(isReviewsResponse(GOOGLE), true);
    assert.equal(isReviewsResponse({ ...GOOGLE, mode: 'disabled' }), false);
  });

  it('W-R5. Externe Links nur https', () => {
    assert.equal(safeHttpsUrl('https://www.google.com/maps'), 'https://www.google.com/maps');
    assert.equal(safeHttpsUrl('http://www.google.com/maps'), null);
    assert.equal(safeHttpsUrl('javascript:alert(1)'), null);
    assert.equal(safeHttpsUrl(null), null);
  });
});
