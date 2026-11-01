import type {
  DoneFuncWithErrOrRes,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
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
 * 3. Freigabe (idempotent) gebunden an den ABSCHLUSS DES HANDLERS, nie an das
 *    Socket (Review F1): `onSend` (läuft nach dem Handler bzw. nach der
 *    Fehlerbehandlung – AUCH wenn der Client die Verbindung inzwischen
 *    abgebrochen hat; die Payload wird unverändert zurückgegeben), dazu
 *    `onError` und `onResponse` (idempotent). `onSend` ist bewusst ein
 *    SYNCHRONER Callback-Hook: die Unlock-Anweisung wird sofort abgesetzt
 *    (die Mutation ist beendet), aber nicht abgewartet – ein asynchroner
 *    onSend-Hook würde das Senden verzögern, und Handler, die `reply.send()`
 *    aufrufen und dann `undefined` zurückgeben (Muster `sendError`), würden
 *    über Fastifys Fallback ein zweites Mal senden (leerer Body,
 *    ERR_HTTP_HEADERS_SENT). `onRequestAbort`, `onTimeout`
 *    und das `close`-Ereignis des Sockets geben NICHT frei: Fastify bricht
 *    einen laufenden Handler bei Client-Abbruch nicht ab – die Mutation läuft
 *    weiter und muss bis zu ihrem Ende unter dem Shared-Lock bleiben, sonst
 *    könnte der Reset Phase B beginnen, während der Handler noch schreibt
 *    (`onRequestAbort` feuert bei vollständig gelesenem Body ohnehin nicht).
 *    Ein Handler, der nie endet, hält den Lock bis zum Prozessende – das ist
 *    der Fall „hängender Request“, den der Barrier-Timeout des Resets
 *    (`DEMO_RESET_BARRIER_TIMEOUT`, 409, fail-closed) abdeckt. Erfolg,
 *    Fachfehler (4xx), Exception (500), Client-Abbruch: kein Lock-Leak
 *    (RB10–RB14, RB-A1).
 *
 * Scheitert der Lock-Erwerb selbst (Lock-Pool/DB nicht erreichbar), antwortet
 * der Hook fail-closed mit 503 `DATABASE_UNAVAILABLE` – eine Mutation ohne
 * Barrier ist nie erlaubt. Logs nennen nur Fehlerklasse/-code.
 */

export const DEMO_BARRIER_UNAVAILABLE_CODE = 'DATABASE_UNAVAILABLE';
export const DEMO_BARRIER_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export interface DemoBarrierHooksLogger {
  warn(context: Record<string, unknown>, message: string): void;
  debug?(context: Record<string, unknown>, message: string): void;
}

export interface DemoBarrierHooksOptions {
  logger?: DemoBarrierHooksLogger | undefined;
}

export interface DemoBarrierHooks {
  onRequest(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  /**
   * Freigabe nach Handler-Abschluss (auch bei abgebrochenem Client); Payload
   * unverändert. Synchroner Callback-Hook (`done` wird sofort gerufen).
   */
  onSend(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: DoneFuncWithErrOrRes,
  ): void;
  onResponse(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  onError(request: FastifyRequest, reply: FastifyReply, error: FastifyError): Promise<void>;
  /** Gibt NICHT frei (Handler läuft weiter) – nur Debug-Log. */
  onRequestAbort(request: FastifyRequest): Promise<void>;
  /** Gibt NICHT frei (Handler läuft weiter) – nur Debug-Log. */
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

  /** Review F1: Client weg, Handler läuft weiter – die Lease bleibt bis zum Handlerende. */
  const noteClientGone = (request: FastifyRequest, event: 'abort' | 'timeout'): void => {
    if (!leases.has(request)) return;
    options.logger?.debug?.(
      { event, requestId: request.id },
      'Demo-Reset-Barrier: Client-Verbindung beendet – Shared-Lock bleibt bis zum Handlerende',
    );
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
      return undefined;
    },
    onSend: (request, _reply, payload, done) => {
      // Unlock sofort absetzen (release() wirft nie), Antwort nicht verzögern.
      void releaseFor(request);
      done(null, payload);
    },
    onResponse: (request) => releaseFor(request),
    onError: (request) => releaseFor(request),
    onRequestAbort: async (request) => {
      noteClientGone(request, 'abort');
    },
    onTimeout: async (request) => {
      noteClientGone(request, 'timeout');
    },
    activeLeases: () => active,
  };
}

/** Alle Barrier-Hooks auf der Root-Instanz registrieren (NACH dem Gate-Hook). */
export function registerDemoBarrierHooks(app: FastifyInstance, hooks: DemoBarrierHooks): void {
  app.addHook('onRequest', hooks.onRequest);
  app.addHook('onSend', hooks.onSend);
  app.addHook('onResponse', hooks.onResponse);
  app.addHook('onError', hooks.onError);
  app.addHook('onRequestAbort', hooks.onRequestAbort);
  app.addHook('onTimeout', hooks.onTimeout);
}
