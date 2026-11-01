import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TrainingFeatureKey } from './features.ts';
import {
  TrainingGateError,
  TrainingGateUnavailableError,
  type TrainingGate,
} from './gate-service.ts';

/**
 * Phase 14 (Design §4.5): HTTP-Anbindung der Live-Trainingssperre. Antwort
 * bei Verstoß: 403 mit eigenem Code (`TRAINING_REQUIRED` |
 * `TRAINING_CONFIGURATION_INVALID`), verständlichem deutschen Text (§66) und
 * `details` (featureKey, requiredTrainingKey, title) – Muster `sendTourError`.
 */
export function sendTrainingGateError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: TrainingGateError,
): void {
  void reply.status(403).send({
    error: {
      code: error.trainingCode,
      message: error.message,
      correlationId: request.id,
      details: error.details,
    },
  });
}

/**
 * Phase 14 Final §13 (Review F2): Katalog nicht verfügbar ⇒ Fachaktion bleibt
 * blockiert (fail-closed), Antwort 503 `TRAINING_CATALOG_UNAVAILABLE` ohne
 * Interna (Log nur Feature-Key) – für Routen (`requireTrainingGate`) und den
 * Offline-Sync (`routes/offline.ts`) identisch.
 */
export function sendTrainingGateUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  error: TrainingGateUnavailableError,
): void {
  request.log.warn(
    { featureKey: error.featureKey },
    'Trainingskatalog nicht verfügbar – Live-Sperre blockiert die Aktion (fail-closed)',
  );
  void reply.status(503).send({
    error: {
      code: error.trainingCode,
      message: error.message,
      correlationId: request.id,
      details: { featureKey: error.featureKey },
    },
  });
}

/**
 * Reihenfolge in den Routen (§64): requireAuth → requirePermission(s) →
 * requireTrainingGate → Fachaufruf. Antwortet selbst mit 403 und gibt dann
 * false zurück; andere Fehler laufen weiter.
 */
export async function requireTrainingGate(
  request: FastifyRequest,
  reply: FastifyReply,
  gate: TrainingGate,
  userId: string,
  featureKey: TrainingFeatureKey,
): Promise<boolean> {
  try {
    await gate.assert({ userId, featureKey, now: new Date() });
    return true;
  } catch (error) {
    if (error instanceof TrainingGateError) {
      sendTrainingGateError(request, reply, error);
      return false;
    }
    // Phase 14 Final §13: Katalog nicht verfügbar ⇒ Fachaktion bleibt blockiert (fail-closed),
    // Antwort wie die Trainingsrouten (503, ohne Interna – Log nur Feature-Key).
    if (error instanceof TrainingGateUnavailableError) {
      sendTrainingGateUnavailable(request, reply, error);
      return false;
    }
    throw error;
  }
}
