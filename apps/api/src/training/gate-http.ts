import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TrainingFeatureKey } from './features.ts';
import { TrainingGateError, type TrainingGate } from './gate-service.ts';

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
    throw error;
  }
}
