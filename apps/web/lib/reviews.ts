/**
 * Phase 16 (WEB, Order §18, Design §1.5/§4/§11.2.6): Bewertungen per Klick-zum-Laden.
 *
 * Erst der Klick auf „Bewertungen anzeigen“ ruft `GET /api/public/reviews` (serverseitig ⇒
 * Provider, kein Cache, nichts gespeichert). Kein Google-JavaScript, kein Widget. Ohne aktiven
 * Provider (`disabled`) gibt es die Sektion nicht. Demo-Bewertungen sind immer als DEMO
 * gekennzeichnet und nie als „Google“ beschriftet. Google: Attribution „Google Maps“,
 * Richtlinienhinweis + Link, Übersetzungshinweis, Originaltext aufklappbar (Review
 * demo_reviews-1/-4). Fail-closed: Antwort mit anderem Modus als der SSR-Modus ⇒ „nicht
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

/** Pflicht-Attribution im Google-Modus (POL: Text „Google Maps“, wenn kein Logo). */
export const GOOGLE_ATTRIBUTION = 'Google Maps';
/** Fallback-Link der Google-Richtlinie (wie `GOOGLE_REVIEWS_POLICY_URI` der API). */
export const GOOGLE_POLICY_URI = 'https://support.google.com/contributionpolicy/answer/7422880';

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
 * Attributionszeile: Demo nie „Google“ (Order §18/Design §4); Google immer exakt „Google Maps“
 * (POL – die Web-Darstellung setzt den Text in `<span translate="no">` mit nowrap).
 */
export function attributionText(response: PublicReviewsResponse): string {
  if (response.mode === 'demo') {
    return /google/i.test(response.attribution)
      ? 'DEMO – synthetische Beispielbewertungen'
      : response.attribution;
  }
  return GOOGLE_ATTRIBUTION;
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
