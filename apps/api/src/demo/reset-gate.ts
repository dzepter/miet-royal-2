import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DemoDatasetService } from './dataset.ts';
import { DEMO_MESSAGES } from './types.ts';

/**
 * Phase 14 (Order §20, Design §7): Reset-Gate der Demo-Umgebung. Während
 * `demo_dataset_state.reset_in_progress` gesetzt ist, werden neue
 * Business-Mutationen serverseitig mit 503 `DEMO_RESET` abgewiesen
 * (`retry-after: 15`); der Worker legt Business-Jobs über denselben Zustand
 * zurück. Der Zustand wird mit einem kurzen In-Process-Cache gelesen (TTL
 * 1 s). Bei DB-Fehlern läuft die Anfrage normal weiter (fail-open nur für den
 * Gate-Check – die Route scheitert dann ohnehin an der Datenbank); Inhalte
 * oder Fehlermeldungen der Datenbank werden nie geloggt.
 */

export const DEMO_RESET_ERROR_CODE = 'DEMO_RESET';
export const DEMO_RESET_RETRY_AFTER_SECONDS = 15;
export const DEMO_RESET_GATE_CACHE_TTL_MS = 1000;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Pfadbereiche mit Business-Mutationen (Design §7). Phase 15 (portal, Order §47):
 * `/portal` – alle Kundenportal-Mutationen (Login-Request/-Consume, Logout,
 * Reauth, E-Mail-Wechsel, Profil, Chat, Foto, Storno) laufen während eines
 * Resets auf 503 DEMO_RESET; die Barrier-Hooks nutzen dieselbe Entscheidung
 * (Shared-Lock über die gesamte Mutation). Es gibt keine Portal-Ausnahme.
 */
const GATED_PREFIXES = ['/staff', '/public', '/webhooks', '/portal'] as const;
/**
 * Ausnahmen: Anmeldung/Sperre/Abmeldung, die Demo-Verwaltung selbst (Status,
 * erneuter Reset nach Abbruch), Push-Geräte (keine Business-Daten) und die
 * Offline-Lease (Verlängerung/Widerruf ist keine Business-Mutation; das
 * Arbeitspaket (`/staff/offline/package`) bleibt gesperrt, weil es Daten
 * liefern würde, die gerade gelöscht werden).
 */
const EXEMPT_PREFIXES = ['/auth', '/staff/demo', '/staff/push', '/staff/offline/lease'] as const;

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Reine Entscheidung (ohne Zustand): fällt diese Anfrage unter das Reset-Gate? */
export function isDemoGatedRequest(method: string, url: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  const path = url.split('?')[0] ?? url;
  if (EXEMPT_PREFIXES.some((prefix) => underPrefix(path, prefix))) return false;
  return GATED_PREFIXES.some((prefix) => underPrefix(path, prefix));
}

export interface DemoResetGateLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface DemoResetGate {
  /** Zustand aus `demo_dataset_state` (In-Process-Cache, TTL `cacheTtlMs`). */
  isResetInProgress(): Promise<boolean>;
  /** Cache verwerfen – direkt nach Beginn/Ende eines Resets im selben Prozess. */
  invalidate(): void;
  /** Fastify-`onRequest`-Hook (nur in demo registrieren, VOR dem Routen-Plugin). */
  onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export interface DemoResetGateOptions {
  dataset: Pick<DemoDatasetService, 'resetInProgress'>;
  cacheTtlMs?: number;
  logger?: DemoResetGateLogger;
  /** Nur Tests: Zeitquelle für den Cache. */
  now?: () => number;
}

export function createDemoResetGate(options: DemoResetGateOptions): DemoResetGate {
  const ttl = options.cacheTtlMs ?? DEMO_RESET_GATE_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cached: { value: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  const isResetInProgress = async (): Promise<boolean> => {
    if (cached !== null && now() - cached.at < ttl) return cached.value;
    if (inFlight !== null) return inFlight;
    inFlight = options.dataset
      .resetInProgress()
      .then((value) => {
        cached = { value, at: now() };
        return value;
      })
      .catch((error: unknown) => {
        // Nur Fehlerklasse/-code – nie Meldung oder SQL (Order §38).
        options.logger?.warn(
          {
            errorName: error instanceof Error ? error.name : typeof error,
            errorCode:
              typeof (error as { code?: unknown } | null)?.code === 'string'
                ? (error as { code: string }).code
                : null,
          },
          'Demo-Reset-Gate: Zustand nicht lesbar – Anfrage wird normal verarbeitet',
        );
        cached = { value: false, at: now() };
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    isResetInProgress,
    invalidate: () => {
      cached = null;
    },
    onRequest: async (request, reply) => {
      // Review F1: die GEROUTETE (dekodierte) URL prüfen, nicht den rohen
      // `request.url` – find-my-way dekodiert Percent-Sequenzen vor dem Routing,
      // `/%73taff/customers` erreicht also `/staff/customers`, während der rohe
      // Pfad am Präfixvergleich vorbeiliefe. Ohne passende Route (404) bleibt
      // der rohe Pfad (Vorbild routes/tours-live.ts).
      const routedUrl = request.routeOptions.url ?? request.url;
      if (!isDemoGatedRequest(request.method, routedUrl)) return;
      if (!(await isResetInProgress())) return;
      void reply
        .header('retry-after', String(DEMO_RESET_RETRY_AFTER_SECONDS))
        .status(503)
        .send({
          error: {
            code: DEMO_RESET_ERROR_CODE,
            message: DEMO_MESSAGES.DEMO_RESET,
            correlationId: request.id,
          },
        });
    },
  };
}
