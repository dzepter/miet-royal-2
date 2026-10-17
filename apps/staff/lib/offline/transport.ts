'use client';

import {
  SessionInvalidError,
  TransientSyncError,
  type ConflictDetails,
  type OfflineEnvironment,
  type SyncMutationInput,
  type SyncOutcome,
  type SyncOutcomeResponse,
  type SyncTransport,
} from '@mietroyal/offline';

/**
 * HTTP-Transport der Sync-Queue (Phase-8-Order §§30, 61): ein Request je
 * Mutation an POST /staff/offline/sync. Netzfehler und 5xx gelten als
 * vorübergehend (Backoff), 401 beendet den Lauf (Sitzung ungültig/gesperrt),
 * Fachantworten (applied/conflict/rejected) kommen 1:1 aus dem Orchestrator.
 * 409 = harte Serverablehnung (Umgebung/Lease) – als Konflikt mit Code, nie
 * als Erfolg; 413/400 = endgültig abgelehnt (keine Wiederholung).
 */
const SYNC_TIMEOUT_MS = 90_000;

export function createSyncTransport(options: {
  deviceId: string;
  environment: OfflineEnvironment;
}): SyncTransport {
  return {
    async send(envelope: SyncMutationInput): Promise<SyncOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch('/api/staff/offline/sync', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deviceId: options.deviceId,
            environment: options.environment,
            clientTime: new Date().toISOString(),
            mutation: envelope,
          }),
          signal: controller.signal,
        });
      } catch {
        throw new TransientSyncError('NETWORK_ERROR');
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401) throw new SessionInvalidError();
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const processedAt = new Date().toISOString();
      const errorBody = payload as { error?: { code?: string; message?: string } } | null;
      if (response.status === 409) {
        return {
          status: 'conflict',
          code: errorBody?.error?.code ?? 'SERVER_STATE_CHANGED',
          message:
            errorBody?.error?.message ??
            'Der Server hat die Übertragung abgelehnt – bitte Serverstand prüfen.',
          serverState: null,
          processedAt,
        };
      }
      if (response.status === 413) {
        return {
          status: 'rejected',
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Die Übertragung ist zu groß (Fotos/Unterschriften).',
          processedAt,
        };
      }
      if (response.status === 400) {
        return {
          status: 'rejected',
          code: errorBody?.error?.code ?? 'VALIDATION',
          message: errorBody?.error?.message ?? 'Die Übertragung wurde als ungültig abgelehnt.',
          processedAt,
        };
      }
      if (!response.ok) throw new TransientSyncError(`HTTP_${response.status}`);
      return mapOutcome(payload as Partial<SyncOutcomeResponse> | null, processedAt);
    },
  };
}

function mapOutcome(body: Partial<SyncOutcomeResponse> | null, fallbackAt: string): SyncOutcome {
  const processedAt = body?.processedAt ?? fallbackAt;
  if (body?.status === 'applied') {
    return { status: 'applied', resultRef: body.resultRef ?? null, processedAt };
  }
  // Fachliche Gegenüberstellung (§4) – nur kurze Sätze, wird verschlüsselt gespeichert.
  const details = conflictDetails(body?.details);
  if (body?.status === 'conflict') {
    return {
      status: 'conflict',
      code: body.code ?? 'SERVER_STATE_CHANGED',
      message: body.message ?? 'Der Serverstand hat sich geändert – bitte prüfen.',
      serverState: null,
      details,
      processedAt,
    };
  }
  return {
    status: 'rejected',
    code: body?.code ?? 'VALIDATION',
    message: body?.message ?? 'Die Übertragung wurde abgelehnt.',
    details,
    processedAt,
  };
}

function conflictDetails(value: unknown): ConflictDetails | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof raw[key] === 'string' && (raw[key] as string).trim() !== ''
      ? (raw[key] as string)
      : null;
  const details = { offline: text('offline'), server: text('server'), action: text('action') };
  return details.offline === null && details.server === null && details.action === null
    ? null
    : details;
}
