/**
 * Phase 16 (WEB, Design §2.4, Order §9): Vorschau von CMS-Entwürfen im echten Web-Renderer.
 *
 * Ablauf: Staff öffnet `/vorschau#token=…` ⇒ das Fragment wird gelesen und SOFORT aus der
 * Adresszeile entfernt ⇒ `POST /api/public/cms/preview/consume { token }` ⇒ die API setzt das
 * HttpOnly-Cookie (`__Host-mr_cms_preview`, in development `mr_cms_preview`) ⇒ `/vorschau/seite`
 * liest das Cookie serverseitig und reicht es an `GET /public/cms/preview/page` weiter.
 * Token und Cookie-Wert werden nie geloggt, nie in Query/Storage abgelegt.
 * Reine Funktionen (node --test).
 */
import { readTokenFromHash } from './portal.ts';

export const PREVIEW_PAGE_PATH = '/vorschau/seite';
export const PREVIEW_CONSUME_URL = '/api/public/cms/preview/consume';

/** Cookie-Namen der API (Design §2.4.3) – Reihenfolge: Produktion vor development. */
export const PREVIEW_COOKIE_NAMES = ['__Host-mr_cms_preview', 'mr_cms_preview'] as const;

/** Sitzungstoken sind base64url (32 Byte ⇒ 43 Zeichen); hier nur Zeichenklasse/Länge. */
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export const PREVIEW_TEXT = {
  OPENING: 'Vorschau wird geöffnet …',
  MISSING: 'Kein Vorschau-Link erkannt. Bitte öffne die Vorschau erneut aus der Staff-App.',
  INVALID:
    'Dieser Vorschau-Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte erzeuge in der Staff-App eine neue Vorschau.',
  NO_SESSION:
    'Es ist keine Vorschau aktiv oder sie ist abgelaufen. Bitte öffne die Vorschau erneut aus der Staff-App.',
  RATE_LIMITED: 'Zu viele Versuche. Bitte warte einen Moment und öffne die Vorschau dann erneut.',
  DEMO_RESET:
    'Die Demo-Umgebung wird gerade zurückgesetzt. Bitte versuche es in einer Minute erneut.',
  UNAVAILABLE: 'Die Vorschau ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.',
  DISABLED:
    'Die Vorschau ist in dieser Umgebung gerade nicht verfügbar (Konfiguration der Website prüfen).',
} as const;

/** `#token=…` ⇒ Token oder null (gleiches Muster wie der Portal-Magic-Link). */
export function readPreviewToken(hash: string | null | undefined): string | null {
  return readTokenFromHash(hash);
}

/**
 * Cookie-Header für die API aus den eingehenden Cookies – nur die Vorschau-Cookies, nur
 * wohlgeformte Werte (kein Header-Injection-Risiko). Ohne passendes Cookie ⇒ null.
 */
export function previewCookieHeader(
  getCookie: (name: string) => string | undefined,
): string | null {
  const parts: string[] = [];
  for (const name of PREVIEW_COOKIE_NAMES) {
    const value = getCookie(name);
    if (value !== undefined && COOKIE_VALUE_PATTERN.test(value)) parts.push(`${name}=${value}`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

export type PreviewConsumeOutcome =
  | { kind: 'ok'; path: string | null; entryKind: string; expiresAt: string }
  | { kind: 'invalid' }
  | { kind: 'rate_limited' }
  | { kind: 'demo_reset' }
  | { kind: 'unavailable' };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** Übersetzt Status/Code der Consume-Antwort (rein, ohne Netz). */
export function interpretConsumeResponse(status: number, body: unknown): PreviewConsumeOutcome {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (status >= 200 && status < 300 && typeof record.expiresAt === 'string') {
    return {
      kind: 'ok',
      path: typeof record.path === 'string' ? record.path : null,
      entryKind: typeof record.entryKind === 'string' ? record.entryKind : 'page',
      expiresAt: record.expiresAt,
    };
  }
  const error =
    typeof record.error === 'object' && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {};
  if (status === 401 || status === 400 || status === 403) return { kind: 'invalid' };
  if (status === 429) return { kind: 'rate_limited' };
  if (status === 503 && error.code === 'DEMO_RESET') return { kind: 'demo_reset' };
  return { kind: 'unavailable' };
}

/** POST Consume über den Same-Origin-Rewrite (Cookie setzt die API). */
export async function consumePreviewToken(
  token: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<PreviewConsumeOutcome> {
  try {
    const response = await fetchImpl(PREVIEW_CONSUME_URL, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body: unknown = await response.json().catch(() => null);
    return interpretConsumeResponse(response.status, body);
  } catch {
    return { kind: 'unavailable' };
  }
}

export function consumeOutcomeMessage(
  outcome: Exclude<PreviewConsumeOutcome, { kind: 'ok' }>,
): string {
  switch (outcome.kind) {
    case 'invalid':
      return PREVIEW_TEXT.INVALID;
    case 'rate_limited':
      return PREVIEW_TEXT.RATE_LIMITED;
    case 'demo_reset':
      return PREVIEW_TEXT.DEMO_RESET;
    case 'unavailable':
      return PREVIEW_TEXT.UNAVAILABLE;
  }
}

/** Banner-Text der Vorschau (Design §2.4.4). */
export function previewBannerText(preview: { revisionNumber: number; entryKind: string }): string {
  const what = preview.entryKind === 'site_settings' ? 'Website-Einstellungen' : 'Entwurf';
  return `Vorschau – ${what} (Revision ${preview.revisionNumber}), nicht veröffentlicht`;
}
