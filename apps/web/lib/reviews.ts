/**
 * Phase 16 (WEB, Order §18, Design §1.5/§4/§11.2.6): Bewertungen per Klick-zum-Laden.
 *
 * Erst der Klick auf „Bewertungen anzeigen“ ruft `GET /api/public/reviews` (serverseitig ⇒
 * Provider, kein Cache, nichts gespeichert). Kein Google-JavaScript, kein Widget. Ohne aktiven
 * Provider (`disabled`) gibt es die Sektion nicht. Demo-Bewertungen sind immer als DEMO
 * gekennzeichnet und nie als „Google“ beschriftet. Google: Attribution mit dem offiziellen
 * Google-Maps-Logo (Phase 17, Design D19 / Auftrag §25 – POL: „Attribution should take the form
 * of the Google Maps logo whenever possible“; Text „Google Maps“ nur als Accessibility-Label und
 * in Linktexten), Richtlinienhinweis + Link, Übersetzungshinweis, Originaltext aufklappbar
 * (Review demo_reviews-1/-4). Fail-closed: Antwort mit anderem Modus als der SSR-Modus ⇒ „nicht
 * verfügbar“; Build-/Laufzeit-Origin-Abweichung ⇒ Sektion wie `disabled` (demo_reviews-2,
 * web_security-1). Reine Funktionen (node --test).
 */
import type { PublicReview, PublicReviewsResponse, ReviewMode } from './site-types.ts';

export const REVIEWS_URL = '/api/public/reviews';

export const REVIEWS_TEXT = {
  BUTTON: 'Bewertungen anzeigen',
  LOADING: 'Bewertungen werden geladen …',
  GOOGLE_NOTICE: 'Beim Laden werden Bewertungen und Profilbilder von Google abgerufen.',
  DEMO_NOTICE: 'Synthetische DEMO-Beispielbewertungen – keine echten Kundenmeinungen.',
  UNAVAILABLE: 'Bewertungen sind gerade nicht verfügbar.',
  TRANSLATED: 'Von Google übersetzt',
  DEMO_BADGE: 'DEMO',
  /**
   * Lokaler Fallback des Richtlinienhinweises (Google POL „Inform end users of Google's review
   * policy“; Wortlaut wie `GOOGLE_REVIEWS_POLICY_NOTE` der API) – der Hinweis fehlt nie.
   */
  POLICY_NOTE:
    'Google prüft Bewertungen nicht, sucht aber nach gefälschten Inhalten und entfernt sie, sobald sie erkannt werden.',
  POLICY_LINK: 'Zur Richtlinie von Google für Bewertungen',
  ORIGINAL_TEXT: 'Originaltext anzeigen',
} as const;

/**
 * Pflicht-Attribution im Google-Modus (POL). Seit Phase 17 (D19) ist das Logo die Attribution;
 * der Text „Google Maps“ bleibt dessen Accessibility-Label (alt) und steht in den Linktexten
 * („Alle Bewertungen auf Google Maps“, „Auf Google Maps ansehen“ – Linktext, keine Attribution).
 */
export const GOOGLE_ATTRIBUTION = 'Google Maps';
/** Fallback-Link der Google-Richtlinie (wie `GOOGLE_REVIEWS_POLICY_URI` der API). */
export const GOOGLE_POLICY_URI = 'https://support.google.com/contributionpolicy/answer/7422880';

/**
 * Offizielles Google-Maps-Attributionsasset (Phase 17, Design D19 / Auftrag §25).
 *
 * POL (Stand 2026-11-09): „Attribution should take the form of the Google Maps logo whenever
 * possible. In cases where space is limited, the text Google Maps is acceptable.“ – eine
 * Website-Sektion hat keinen Platzmangel ⇒ Logo. Vorgaben: „Use the official Google Maps logo
 * files.“ – „Don't modify the logo in any way.“ – „Maintain the aspect ratio“ – non-outlined
 * Variante auf ruhigem Hintergrund – Höhe 16–19 dp – Freiraum ≥ 10 dp links/rechts/oben,
 * ≥ 5 dp unten – Accessibility-Label „Google Maps“ – oben oder unten innerhalb desselben
 * Containers – nie inline im Fließtext (GEO-BRAND).
 *
 * Datei: unveränderte Kopie von `GoogleMaps_Logo_Gray.svg` aus
 * https://developers.google.com/static/maps/documentation/images/Google_Maps_Attribution_Assets.zip
 * (Zip 2025-07-08, kopiert 12.11.2026, SHA-256 in `reviews.test.ts`), lokal aus `apps/web/public/`
 * (kein Hotlink, kein Nachbau, kein CSS-Filter). Gray #5E5E5E auf dem Creme-Hintergrund #FFFCF2
 * der Sektion: Kontrast 6,3:1. Weitere Varianten (White, outlined) werden nicht gebraucht – die
 * Sektion liegt nie auf dunklem Grund oder auf einem Bild.
 */
export const GOOGLE_MAPS_LOGO = {
  src: '/google-maps-logo-gray.svg',
  alt: GOOGLE_ATTRIBUTION,
  /** Natives Seitenverhältnis des Assets (viewBox 0 0 98 18); CSS-Höhe 18 px liegt in 16–19 dp. */
  width: 98,
  height: 18,
  /**
   * Vertikaler Freiraum um das Logo in px (POL ≥ 10 dp) – zugleich wächst die Linkfläche auf
   * 18 + 2 × 13 = 44 px Höhe (UX_RULES: Touchflächen ≥ 44 px). Horizontal sorgen Flex-Abstand
   * (`.reviewSummary`, 1rem) und Seitenrand (`.container`, ≥ 1rem) für ≥ 16 px.
   */
  clearSpacePx: 13,
} as const;

/** Sektion nur bei aktivem Provider (Order §18: ohne echten Provider komplett ausblenden). */
export function reviewsSectionVisible(mode: ReviewMode | string | null | undefined): boolean {
  return mode === 'google' || mode === 'demo';
}

/**
 * Modus der Bewertungs-Sektion aus dem SSR-Bootstrap – fail-closed (Review demo_reviews-2 /
 * web_security-1): Weichen Build- und Laufzeit-Origin der API ab, ginge der Klick über den
 * eingebackenen `/api`-Rewrite an eine ANDERE Umgebung (Live-Google aus Demo bzw.
 * Fake-Bewertungen auf Live) ⇒ Sektion wie `disabled`. Unbekannte Werte ⇒ `disabled`.
 */
export function effectiveReviewsMode(
  bootstrapMode: ReviewMode | string | null | undefined,
  originMismatch: boolean,
): ReviewMode {
  if (originMismatch) return 'disabled';
  return bootstrapMode === 'google' || bootstrapMode === 'demo' ? bootstrapMode : 'disabled';
}

/**
 * Antwort nur anzeigen, wenn ihr Modus dem SSR-Modus der Seite entspricht (Demo-Seite zeigt nie
 * Google-Inhalte, Live-Seite nie Demo-Bewertungen) – sonst „nicht verfügbar“.
 */
export function acceptReviewsResponse(
  expectedMode: ReviewMode | string,
  response: Pick<PublicReviewsResponse, 'mode'>,
): boolean {
  return reviewsSectionVisible(expectedMode) && response.mode === expectedMode;
}

export function reviewsNotice(mode: ReviewMode | string): string {
  return mode === 'demo' ? REVIEWS_TEXT.DEMO_NOTICE : REVIEWS_TEXT.GOOGLE_NOTICE;
}

/** Nur https-Links (Autor, Bewertung, Melden, Ort) – alles andere wird nicht verlinkt. */
export function safeHttpsUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isReview(value: unknown): value is PublicReview {
  if (typeof value !== 'object' || value === null) return false;
  const review = value as Record<string, unknown>;
  return (
    typeof review.authorName === 'string' &&
    typeof review.rating === 'number' &&
    typeof review.text === 'string'
  );
}

export function isReviewsResponse(value: unknown): value is PublicReviewsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.mode === 'google' || record.mode === 'demo') &&
    typeof record.attribution === 'string' &&
    Array.isArray(record.reviews) &&
    record.reviews.every(isReview)
  );
}

/**
 * Google-Pflicht-Attribution (Design §11.2.6): im Google-Modus nur Bewertungen mit Autorname,
 * Autor-Link und Profilbild (https); Demo-Bewertungen haben weder Links noch Fotos.
 */
export function displayableReviews(response: PublicReviewsResponse): PublicReview[] {
  if (response.mode === 'demo') {
    return response.reviews.map((review) => ({
      ...review,
      authorUri: null,
      authorPhotoUri: null,
      reviewUri: null,
      flagUri: null,
      translated: false,
      originalText: null,
    }));
  }
  return response.reviews.filter(
    (review) =>
      review.authorName.trim() !== '' &&
      safeHttpsUrl(review.authorUri) !== null &&
      safeHttpsUrl(review.authorPhotoUri) !== null,
  );
}

/**
 * Attributionstext: Demo nie „Google“ (Order §18/Design §4); Google immer exakt „Google Maps“
 * (POL) – seit Phase 17 (D19) als Accessibility-Label des Logos (`GOOGLE_MAPS_LOGO.alt`), nicht
 * mehr als sichtbare Textattribution (siehe `reviewsAttribution`).
 */
export function attributionText(response: PublicReviewsResponse): string {
  if (response.mode === 'demo') {
    return /google/i.test(response.attribution)
      ? 'DEMO – synthetische Beispielbewertungen'
      : response.attribution;
  }
  return GOOGLE_ATTRIBUTION;
}

export type ReviewsAttribution =
  | {
      /** Google-Modus: offizielles Google-Maps-Logo (`<img>` mit alt „Google Maps“). */
      kind: 'google-maps-logo';
      src: string;
      alt: string;
      width: number;
      height: number;
      /** Link auf den Ort bei Google Maps (`placeUri`, nur https), sonst null ⇒ Logo ohne Link. */
      href: string | null;
    }
  | {
      /** Demo-Modus: sichtbarer Text, nie „Google“, nie ein Logo. */
      kind: 'text';
      text: string;
    };

/**
 * Attribution der Sektion (Phase 17, D19): Google ⇒ Logo-Attribution (offizielles Asset, verlinkt
 * auf `placeUri`, wenn https); Demo ⇒ Text „DEMO – synthetische Beispielbewertungen“ ohne Logo.
 */
export function reviewsAttribution(response: PublicReviewsResponse): ReviewsAttribution {
  if (response.mode === 'google') {
    return {
      kind: 'google-maps-logo',
      src: GOOGLE_MAPS_LOGO.src,
      alt: GOOGLE_MAPS_LOGO.alt,
      width: GOOGLE_MAPS_LOGO.width,
      height: GOOGLE_MAPS_LOGO.height,
      href: safeHttpsUrl(response.placeUri),
    };
  }
  return { kind: 'text', text: attributionText(response) };
}

/** Optionales Textfeld der API (additiv) ⇒ getrimmter String; alles andere ⇒ ''. */
function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Richtlinienhinweis (nur Google, Review demo_reviews-1): Text + https-Link aus der API, mit
 * lokalem Fallback, damit der Hinweis nie fehlt. Demo ⇒ null (nie „Google“).
 */
export function reviewsPolicyNotice(
  response: PublicReviewsResponse,
): { text: string; href: string } | null {
  if (response.mode !== 'google') return null;
  const note = trimmedText(response.policyNote);
  return {
    text: note === '' ? REVIEWS_TEXT.POLICY_NOTE : note,
    href: safeHttpsUrl(response.policyUri) ?? GOOGLE_POLICY_URI,
  };
}

/** Beschriftung übersetzter Bewertungen: `translationNote` der API, Fallback lokal; Demo ⇒ null. */
export function translationLabel(response: PublicReviewsResponse): string | null {
  if (response.mode !== 'google') return null;
  const note = trimmedText(response.translationNote);
  return note === '' ? REVIEWS_TEXT.TRANSLATED : note;
}

/** Originaltext einer übersetzten Google-Bewertung (aufklappbar) – sonst null. */
export function originalTextOf(
  response: PublicReviewsResponse,
  review: PublicReview,
): string | null {
  if (response.mode !== 'google' || review.translated !== true) return null;
  const original = trimmedText(review.originalText);
  return original === '' || original === review.text.trim() ? null : original;
}

export type ReviewsOutcome = { kind: 'ok'; data: PublicReviewsResponse } | { kind: 'unavailable' };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * Lädt die Bewertungen. `expectedMode` = SSR-Modus der Seite: eine Antwort mit anderem Modus
 * (Build-Rewrite zeigt auf eine andere Umgebung) wird verworfen ⇒ `unavailable`.
 */
export async function fetchReviews(
  expectedMode: ReviewMode,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ReviewsOutcome> {
  try {
    const response = await fetchImpl(REVIEWS_URL, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { kind: 'unavailable' };
    const body: unknown = await response.json().catch(() => null);
    if (!isReviewsResponse(body) || !acceptReviewsResponse(expectedMode, body)) {
      return { kind: 'unavailable' };
    }
    return { kind: 'ok', data: body };
  } catch {
    return { kind: 'unavailable' };
  }
}
