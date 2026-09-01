'use client';

/**
 * Schmaler API-Client für die Staff-App. Alle Aufrufe laufen über den
 * Same-Origin-Proxy /api/* (next.config.ts). Bei 401 APP_LOCKED wird ein
 * globales Ereignis ausgelöst, auf das der AuthGuard mit dem Sperrbildschirm
 * reagiert.
 */

export const APP_LOCKED_EVENT = 'mr-app-locked';
export const UNAUTHENTICATED_EVENT = 'mr-unauthenticated';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
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

  const errorBody = payload as { error?: { code?: string; message?: string } } | null;
  const errorCode = errorBody?.error?.code ?? null;

  if (response.status === 401 && errorCode === 'APP_LOCKED') {
    window.dispatchEvent(new Event(APP_LOCKED_EVENT));
  }
  if (response.status === 401 && errorCode === 'UNAUTHENTICATED') {
    window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  }

  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? (payload as T) : null,
    errorCode,
    errorMessage: errorBody?.error?.message ?? null,
  };
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
}

export function hasPermission(me: Me | null, key: string): boolean {
  return me?.permissions?.includes(key) ?? false;
}
