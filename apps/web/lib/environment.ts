/**
 * Phase 14 (Design §3, Web): Umgebung der öffentlichen Web-Instanz und die
 * Entscheidung über den Demo-Banner – nur serverseitig (Server-Komponente im
 * Root-Layout) verwenden.
 *
 * Quelle 1 (deterministisch, nie ausblendbar): `WEB_APP_ENV` der eigenen
 * Deployment-Umgebung (gleiche Werte wie APP_ENV, Default development).
 * Quelle 2 (Review F6, Härtung): `GET <WEB_API_ORIGIN>/health` der
 * konfigurierten API meldet `environment`; meldet sie `demo`, erscheint der
 * Banner ebenfalls (ODER-Logik). Fehler oder Timeout (1 s) ⇒ nur `WEB_APP_ENV`
 * zählt; die Abfrage läuft mit `cache: 'no-store'` je Anfrage.
 * Außerhalb von development ist `WEB_APP_ENV` Pflicht (Deploy-Checkliste in
 * docs/DEPLOYMENT_NOTES.md): fehlt sie, wird das einmal als Fehler geloggt –
 * bewusst ohne Startabbruch, damit die Web-App nicht ausfällt – und die
 * Demo-Kennzeichnung hängt bis zur Korrektur allein an /health.
 */

export const WEB_APP_ENVIRONMENTS = ['development', 'staging', 'demo', 'production'] as const;
export type WebAppEnvironment = (typeof WEB_APP_ENVIRONMENTS)[number];

export const DEMO_BANNER_TEXT = 'DEMO – keine echten Kundendaten';
/** Gleicher Default wie der API-Rewrite in next.config.ts. */
export const DEFAULT_WEB_API_ORIGIN = 'http://127.0.0.1:3101';
/** Zeitbudget der /health-Abfrage je Seitenaufruf (Review F6). */
export const API_HEALTH_TIMEOUT_MS = 1000;

type Reporter = (message: string) => void;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const defaultReporter: Reporter = (message) => console.error(message);
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** Jede Konfigurationsmeldung nur einmal je Prozess (kein Log-Rauschen je Anfrage). */
const reported = new Set<string>();
function reportOnce(key: string, message: string, report: Reporter): void {
  if (reported.has(key)) return;
  reported.add(key);
  report(message);
}

export interface ReadWebAppEnvironmentOptions {
  /** NODE_ENV des Web-Servers (`next start` ⇒ production, `next dev` ⇒ development). */
  nodeEnv?: string | undefined;
  /** Nur Tests: Fehlerausgabe (Default console.error). */
  report?: Reporter | undefined;
}

/**
 * Liest WEB_APP_ENV. Unbekannte Werte werden einmal gemeldet und wie
 * development behandelt; eine FEHLENDE Variable außerhalb von development
 * (NODE_ENV production/staging) ebenfalls einmal gemeldet (kein Abbruch).
 */
export function readWebAppEnvironment(
  value: string | undefined = process.env.WEB_APP_ENV,
  options: ReadWebAppEnvironmentOptions = {},
): WebAppEnvironment {
  const report = options.report ?? defaultReporter;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    if (nodeEnv !== undefined && nodeEnv !== 'development' && nodeEnv !== 'test') {
      reportOnce(
        'missing',
        'WEB_APP_ENV fehlt – außerhalb von development Pflicht (Deploy-Checkliste, docs/DEPLOYMENT_NOTES.md); ' +
          'es gilt development, die Demo-Kennzeichnung hängt bis zur Korrektur allein an GET <WEB_API_ORIGIN>/health.',
        report,
      );
    }
    return 'development';
  }
  if ((WEB_APP_ENVIRONMENTS as readonly string[]).includes(trimmed)) {
    return trimmed as WebAppEnvironment;
  }
  reportOnce(
    'unknown',
    `WEB_APP_ENV: unbekannter Wert – erlaubt sind ${WEB_APP_ENVIRONMENTS.join(', ')}; es gilt development.`,
    report,
  );
  return 'development';
}

/** Origin der konfigurierten API (wie der Rewrite in next.config.ts), ohne Schluss-Slash. */
export function readWebApiOrigin(value: string | undefined = process.env.WEB_API_ORIGIN): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? DEFAULT_WEB_API_ORIGIN : trimmed.replace(/\/+$/, '');
}

/**
 * Review F6: `environment` aus `GET <origin>/health` (API-Antwort
 * `{ status, version, environment }`). Fehler, Timeout, Nicht-2xx oder
 * unerwarteter Inhalt ⇒ null (nur WEB_APP_ENV zählt) – nie eine Ausnahme.
 */
export async function fetchApiEnvironment(
  origin: string,
  options: { timeoutMs?: number | undefined; fetchImpl?: FetchLike | undefined } = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? API_HEALTH_TIMEOUT_MS;
  // Expliziter Timer statt AbortSignal.timeout(): wird nach der Antwort sicher
  // gelöscht und hält den Prozess während der Abfrage am Leben.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/health`, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const environment = (body as { environment?: unknown } | null)?.environment;
    return typeof environment === 'string' ? environment : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reine Entscheidung (Review F6): Banner, wenn EINE der beiden Quellen `demo` meldet. */
export function decideDemoBanner(input: {
  webAppEnv: WebAppEnvironment;
  apiEnvironment: string | null;
}): boolean {
  return input.webAppEnv === 'demo' || input.apiEnvironment === 'demo';
}

export interface ResolveDemoBannerOptions {
  /** Nur Tests: statt WEB_APP_ENV. */
  webAppEnv?: WebAppEnvironment | undefined;
  /** Nur Tests: statt WEB_API_ORIGIN. */
  apiOrigin?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

/**
 * Entscheidung für das Root-Layout: `WEB_APP_ENV=demo` ⇒ immer Banner (ohne
 * API-Abfrage); sonst zählt zusätzlich `environment: 'demo'` der API.
 */
export async function resolveDemoBanner(options: ResolveDemoBannerOptions = {}): Promise<boolean> {
  const webAppEnv = options.webAppEnv ?? readWebAppEnvironment();
  if (webAppEnv === 'demo') return true;
  const apiEnvironment = await fetchApiEnvironment(options.apiOrigin ?? readWebApiOrigin(), {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return decideDemoBanner({ webAppEnv, apiEnvironment });
}
