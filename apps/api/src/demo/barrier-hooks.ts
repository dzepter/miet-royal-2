import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BarrierLease, DemoResetBarrier } from './reset-barrier.ts';
import {
  DEMO_RESET_ERROR_CODE,
  DEMO_RESET_RETRY_AFTER_SECONDS,
  isDemoGatedRequest,
} from './reset-gate.ts';
import { DEMO_MESSAGES } from './types.ts';

/**
 * Phase 14 Final (Order §3, Design B): Shared-Barrier-Lock über die GESAMTE
 * Laufzeit einer Business-Mutation der Demo-API. Hooks auf der Root-Instanz,
 * registriert DIREKT NACH dem Reset-Gate-Hook (`createDemoResetGate`):
 *
 * 1. Reset-Gate (gecacht, TTL 1 s) ⇒ 503 bei bekanntem Reset.
 * 2. `onRequest` (hier): für `isDemoGatedRequest(method, geroutete URL)` –
 *    dieselbe Regel und dieselben Ausnahmen wie das Gate (`/auth/*`,
 *    `/staff/demo/*`, `/staff/push/*`, `/staff/offline/lease*` bleiben ohne
 *    Barrier; die Reset-Route hält damit nie einen Shared-Lock, RB16) –
 *    Shared-Lock OHNE Warten erwerben (`null` ⇒ Reset hält oder beantragt den
 *    Exclusive ⇒ 503 DEMO_RESET), dann `reset_in_progress` DIREKT und
 *    UNCACHED auf der Lock-Verbindung prüfen (⇒ `true`: Lock sofort freigeben,
 *    503 DEMO_RESET, keine Mutation). Sonst läuft der Fachrequest unter dem Lock.
 * 3. Freigabe (idempotent) in `onResponse` UND `onError` UND `onRequestAbort`
 *    UND `onTimeout`, zusätzlich `reply.raw.once('close')` als Backstop –
 *    Erfolg, Fachfehler (4xx), Exception (500), Verbindungsabbruch: kein
 *    Lock-Leak (RB10–RB14).
 *
 * Scheitert der Lock-Erwerb selbst (Lock-Pool/DB nicht erreichbar), antwortet
 * der Hook fail-closed mit 503 `DATABASE_UNAVAILABLE` – eine Mutation ohne
 * Barrier ist nie erlaubt. Logs nennen nur Fehlerklasse/-code.
 */

export const DEMO_BARRIER_UNAVAILABLE_CODE = 'DATABASE_UNAVAILABLE';
export const DEMO_BARRIER_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export interface DemoBarrierHooksLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface DemoBarrierHooksOptions {
  logger?: DemoBarrierHooksLogger | undefined;
}

export interface DemoBarrierHooks {
  onRequest(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  onResponse(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  onError(request: FastifyRequest, reply: FastifyReply, error: FastifyError): Promise<void>;
  onRequestAbort(request: FastifyRequest): Promise<void>;
  onTimeout(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Nur Tests/Diagnose: Anzahl aktuell gehaltener Request-Leases dieses Prozesses. */
  activeLeases(): number;
}

function sendDemoReset(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .header('retry-after', String(DEMO_RESET_RETRY_AFTER_SECONDS))
    .status(503)
    .send({
      error: {
        code: DEMO_RESET_ERROR_CODE,
        message: DEMO_MESSAGES.DEMO_RESET,
        correlationId: request.id,
      },
    });
}

export function createDemoBarrierHooks(
  barrier: Pick<DemoResetBarrier, 'tryAcquireShared'>,
  options: DemoBarrierHooksOptions = {},
): DemoBarrierHooks {
  const leases = new WeakMap<FastifyRequest, BarrierLease>();
  let active = 0;

  const releaseFor = async (request: FastifyRequest): Promise<void> => {
    const lease = leases.get(request);
    if (lease === undefined) return;
    leases.delete(request);
    active -= 1;
    await lease.release();
  };

  return {
    onRequest: async (request, reply) => {
      // Review F1 (Gate): die GEROUTETE URL – Percent-Sequenzen sind dekodiert.
      const routedUrl = request.routeOptions.url ?? request.url;
      if (!isDemoGatedRequest(request.method, routedUrl)) return;
      let lease: BarrierLease | null;
      try {
        lease = await barrier.tryAcquireShared();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        options.logger?.warn(
          {
            errorName: error instanceof Error ? error.name : typeof error,
            errorCode: typeof code === 'string' ? code : null,
          },
          'Demo-Reset-Barrier: Shared-Lock nicht erwerbbar – Mutation abgewiesen (fail-closed)',
        );
        return reply
          .header('retry-after', String(DEMO_BARRIER_UNAVAILABLE_RETRY_AFTER_SECONDS))
          .status(503)
          .send({
            error: {
              code: DEMO_BARRIER_UNAVAILABLE_CODE,
              message: 'Dienst vorübergehend nicht verfügbar. Bitte erneut versuchen.',
              correlationId: request.id,
            },
          });
      }
      if (lease === null) return sendDemoReset(request, reply);
      let inProgress: boolean;
      try {
        inProgress = await lease.isResetInProgressUncached();
      } catch (error) {
        await lease.release();
        throw error;
      }
      if (inProgress) {
        await lease.release();
        return sendDemoReset(request, reply);
      }
      leases.set(request, lease);
      active += 1;
      // Backstop: Verbindung geschlossen, ohne dass ein Response-/Error-Hook lief.
      reply.raw.once('close', () => {
        void releaseFor(request);
      });
      return undefined;
    },
    onResponse: (request) => releaseFor(request),
    onError: (request) => releaseFor(request),
    onRequestAbort: (request) => releaseFor(request),
    onTimeout: (request) => releaseFor(request),
    activeLeases: () => active,
  };
}

/** Alle Barrier-Hooks auf der Root-Instanz registrieren (NACH dem Gate-Hook). */
export function registerDemoBarrierHooks(app: FastifyInstance, hooks: DemoBarrierHooks): void {
  app.addHook('onRequest', hooks.onRequest);
  app.addHook('onResponse', hooks.onResponse);
  app.addHook('onError', hooks.onError);
  app.addHook('onRequestAbort', hooks.onRequestAbort);
  app.addHook('onTimeout', hooks.onTimeout);
}
