/**
 * Phase 16 (WEB, Design §1.6/§5/§11.2.10): serverseitige Lesezugriffe der Website auf die API.
 *
 * - SSR liest direkt `WEB_API_ORIGIN` (nicht über den `/api`-Rewrite): `cache: 'no-store'`,
 *   Timeout ~2,5 s, jeder Fehler wird zu einem neutralen Ergebnis (nie eine Ausnahme ⇒ die
 *   Seite zeigt eine freundliche Meldung statt eines Stacktraces).
 * - Build-/Laufzeit-Origin: Der Browser spricht über den beim Build eingebackenen Rewrite
 *   (`MR_BUILD_API_ORIGIN`), SSR über die Laufzeit-Variable. Weichen beide ab (z. B. Demo-Build
 *   mit Live-API), wird das (nur mit Hostnamen) geloggt und Konfigurator-Absenden sowie
 *   Vorschau fail-closed deaktiviert. Betrieb: Web je Umgebung bauen.
 *
 * Reine Funktionen mit injizierbarem `fetch` (node --test); keine React-Abhängigkeit.
 */
import { readWebApiOrigin } from './environment.ts';
import type {
  PublicCatalog,
  PublicPage,
  PublicPreviewPage,
  PublicSiteBootstrap,
} from './site-types.ts';

export const SITE_API_TIMEOUT_MS = 2500;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Reporter = (message: string) => void;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);
const defaultReporter: Reporter = (message) => console.error(message);

export type SiteFetchFailure = 'not_found' | 'unauthorized' | 'unavailable';
export type SiteFetchResult<T> = { ok: true; data: T } | { ok: false; reason: SiteFetchFailure };

export interface SiteApiOptions {
  /** Default `readWebApiOrigin()`. */
  origin?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
  /** Nur die Vorschau: Cookie-Header für `GET /public/cms/preview/page`. */
  cookie?: string | undefined;
}

/**
 * GET `<origin><path>` als JSON. 404 ⇒ `not_found`, 401 ⇒ `unauthorized`, alles andere
 * (Netz, Timeout, 5xx, kein JSON, Formfehler) ⇒ `unavailable`.
 */
export async function siteApiGet<T>(
  path: string,
  isValid: (value: unknown) => value is T,
  options: SiteApiOptions = {},
): Promise<SiteFetchResult<T>> {
  const origin = options.origin ?? readWebApiOrigin();
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SITE_API_TIMEOUT_MS);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  try {
    const response = await fetchImpl(`${origin}${path}`, {
      method: 'GET',
      cache: 'no-store',
      headers,
      signal: controller.signal,
    });
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (response.status === 401) return { ok: false, reason: 'unauthorized' };
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    const body: unknown = await response.json();
    return isValid(body) ? { ok: true, data: body } : { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

// ── Formprüfungen (nur Struktur, keine Fachregeln) ──────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSiteBootstrap(value: unknown): value is PublicSiteBootstrap {
  return (
    isRecord(value) &&
    typeof value.environment === 'string' &&
    (value.settings === null || isRecord(value.settings)) &&
    Array.isArray(value.pages) &&
    value.pages.every(
      (page) => isRecord(page) && typeof page.path === 'string' && typeof page.title === 'string',
    ) &&
    isRecord(value.reviews) &&
    typeof value.reviews.mode === 'string' &&
    typeof value.pickupArea === 'string'
  );
}

export function isPublicPage(value: unknown): value is PublicPage {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.pageType === 'string' &&
    typeof value.title === 'string' &&
    Array.isArray(value.blocks) &&
    value.blocks.every((block) => isRecord(block) && typeof block.type === 'string')
  );
}

export function isPublicCatalog(value: unknown): value is PublicCatalog {
  return (
    isRecord(value) &&
    Array.isArray(value.machines) &&
    Array.isArray(value.syrups) &&
    Array.isArray(value.accessories) &&
    isRecord(value.included) &&
    typeof value.pickupArea === 'string' &&
    typeof value.largeEventGuestThreshold === 'number' &&
    Array.isArray(value.occasions) &&
    typeof value.priceNote === 'string'
  );
}

export function isPreviewPage(value: unknown): value is PublicPreviewPage {
  return (
    isRecord(value) &&
    isRecord(value.preview) &&
    typeof value.preview.revisionNumber === 'number' &&
    typeof value.preview.expiresAt === 'string' &&
    (value.page === null || isPublicPage(value.page)) &&
    (value.settings === null || isRecord(value.settings))
  );
}

// ── Lesezugriffe ─────────────────────────────────────────────────────────────

/** Pfadformat wie `cms_entries_path_format` (Migration 0033). */
export const SITE_PATH_PATTERN = /^\/([a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*)?$/;

export function loadSiteBootstrap(
  options: SiteApiOptions = {},
): Promise<SiteFetchResult<PublicSiteBootstrap>> {
  return siteApiGet('/public/site/settings', isSiteBootstrap, options);
}

/** Veröffentlichte Seite; ungültiger Pfad ⇒ `not_found` ohne Anfrage. */
export async function loadSitePage(
  path: string,
  options: SiteApiOptions = {},
): Promise<SiteFetchResult<PublicPage>> {
  if (path.length > 200 || !SITE_PATH_PATTERN.test(path)) {
    return { ok: false, reason: 'not_found' };
  }
  return siteApiGet(`/public/site/page?path=${encodeURIComponent(path)}`, isPublicPage, options);
}

export function loadCatalog(options: SiteApiOptions = {}): Promise<SiteFetchResult<PublicCatalog>> {
  return siteApiGet('/public/configurator/catalog', isPublicCatalog, options);
}

/** Vorschau – nur mit dem Cookie-Header des Vorschau-Cookies; ohne ⇒ `unauthorized`. */
export async function loadPreviewPage(
  cookieHeader: string | null,
  options: SiteApiOptions = {},
): Promise<SiteFetchResult<PublicPreviewPage>> {
  if (cookieHeader === null) return { ok: false, reason: 'unauthorized' };
  return siteApiGet('/public/cms/preview/page', isPreviewPage, {
    ...options,
    cookie: cookieHeader,
  });
}

// ── Build-/Laufzeit-Origin (Design §11.2.10) ────────────────────────────────

/** Vom Build eingebackener API-Origin (`next.config.ts` ⇒ `env.MR_BUILD_API_ORIGIN`). */
export function readBuildApiOrigin(): string | undefined {
  return process.env.MR_BUILD_API_ORIGIN;
}

/** Vergleichsform: getrimmt, ohne Schluss-Slashes, Schema/Host klein. */
export function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed;
  }
}

/** Nur der Hostname (für Logs – nie mehr). */
export function originHost(value: string): string {
  try {
    return new URL(value.trim()).hostname || '(ungültig)';
  } catch {
    return '(ungültig)';
  }
}

/**
 * Abweichung zwischen Build- und Laufzeit-Origin. Ohne Build-Wert (außerhalb eines
 * Next-Builds, z. B. Unit-Tests) ⇒ keine Aussage ⇒ false.
 */
export function decideOriginMismatch(build: string | undefined, runtime: string): boolean {
  if (build === undefined || build.trim() === '') return false;
  return normalizeOrigin(build) !== normalizeOrigin(runtime);
}

const reportedMismatch = new Set<string>();

/**
 * Prüft Build- gegen Laufzeit-Origin; meldet eine Abweichung einmal je Prozess und
 * Hostpaar (nur Hostnamen, keine URLs/Ports/Pfade). Rückgabe true ⇒ fail-closed.
 */
export function checkApiOriginMismatch(
  options: {
    build?: string | undefined;
    runtime?: string | undefined;
    report?: Reporter | undefined;
  } = {},
): boolean {
  const build = 'build' in options ? options.build : readBuildApiOrigin();
  const runtime = options.runtime ?? readWebApiOrigin();
  const mismatch = decideOriginMismatch(build, runtime);
  if (mismatch) {
    const key = `${originHost(build ?? '')}→${originHost(runtime)}`;
    if (!reportedMismatch.has(key)) {
      reportedMismatch.add(key);
      (options.report ?? defaultReporter)(
        `WEB_API_ORIGIN weicht vom Build-Origin ab (Schema, Host oder Port; Build-Host ` +
          `${originHost(build ?? '')}, Laufzeit-Host ${originHost(runtime)}) – Konfigurator-Absenden, ` +
          'Vorschau und Bewertungen sind deaktiviert. Die Web-App muss je Umgebung mit ihrem WEB_API_ORIGIN gebaut werden.',
      );
    }
  }
  return mismatch;
}
