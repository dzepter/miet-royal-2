'use client';

/**
 * Schmaler API-Client für die Staff-App. Alle Aufrufe laufen über den
 * Same-Origin-Proxy /api/* (next.config.ts). Bei 401 APP_LOCKED wird ein
 * globales Ereignis ausgelöst, auf das der AuthGuard mit dem Sperrbildschirm
 * reagiert.
 *
 * Phase 8: Ein optional registrierter Offline-Router beantwortet Aufrufe
 * lokal (offline aus dem verschlüsselten Arbeitsbereich; online nur für
 * Kontexte mit noch ausstehenden Offline-Änderungen). Liefert er null, geht
 * der Aufruf normal an den Server – stets mit `cache: 'no-store'`.
 */

export const APP_LOCKED_EVENT = 'mr-app-locked';
export const UNAUTHENTICATED_EVENT = 'mr-unauthenticated';
/** Phase 14 (demo): 503 während eines Demo-Resets – kein Sitzungsproblem, nur Wartezeit. */
export const DEMO_RESET_ERROR_CODE = 'DEMO_RESET';
export const DEMO_RESET_MESSAGE =
  'Die Demo-Umgebung wird gerade zurückgesetzt. Bitte in einer Minute erneut versuchen.';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Phase 13 (UI): strukturierte Fehlerdetails des Servers (z. B. Zuständigkeit, offene Stopps) – optional. */
  errorDetails?: unknown;
}

export type OfflineRouter = (
  path: string,
  method: string,
  body: unknown,
) => Promise<ApiResult<unknown> | null>;

let offlineRouter: OfflineRouter | null = null;

export function setOfflineRouter(router: OfflineRouter | null): void {
  offlineRouter = router;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  if (offlineRouter !== null) {
    const local = await offlineRouter(path, options.method ?? 'GET', options.body);
    if (local !== null) return local as ApiResult<T>;
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      // Fachdaten/Sitzungszustand nie aus dem HTTP-Cache (Phase 8, §4/§78).
      cache: 'no-store',
      headers: options.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
    });
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      errorCode: 'NETWORK_ERROR',
      errorMessage: 'Keine Verbindung zum Server. Bitte erneut versuchen.',
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const errorBody = payload as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  const errorCode = errorBody?.error?.code ?? null;

  if (response.status === 401 && errorCode === 'APP_LOCKED') {
    window.dispatchEvent(new Event(APP_LOCKED_EVENT));
  }
  if (response.status === 401 && errorCode === 'UNAUTHENTICATED') {
    window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  }

  // Phase 14 (demo): 503 DEMO_RESET einheitlich lesbar (kein Logout, keine Sperre).
  const errorMessage =
    response.status === 503 && errorCode === DEMO_RESET_ERROR_CODE
      ? DEMO_RESET_MESSAGE
      : (errorBody?.error?.message ?? null);

  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? (payload as T) : null,
    errorCode,
    errorMessage,
    errorDetails: errorBody?.error?.details,
  };
}

/** Phase 14 (demo): Antwort des 503-Reset-Gates (für gezielte Hinweise in Formularen). */
export function isDemoResetError(result: ApiResult<unknown>): boolean {
  return result.status === 503 && result.errorCode === DEMO_RESET_ERROR_CODE;
}

export interface Me {
  appLocked: boolean;
  user: {
    id?: string;
    firstName: string;
    lastName: string;
    email?: string;
    totpEnabled?: boolean;
    totpRequired?: boolean;
  };
  permissions?: string[];
  /** APP_ENV des Servers (Phase 8: Offline-Namespace). */
  environment?: 'development' | 'staging' | 'demo' | 'production';
  /** Phase 14 (demo): feste Gegen-Umgebung für den Live↔Demo-Wechsel (nur Origin); null/fehlend ⇒ kein Button. */
  counterpart?: { kind: 'demo' | 'live'; url: string } | null;
}

export function hasPermission(me: Me | null, key: string): boolean {
  return me?.permissions?.includes(key) ?? false;
}
