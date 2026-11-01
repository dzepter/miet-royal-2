import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createDemoBarrierHooks, registerDemoBarrierHooks } from '../src/demo/barrier-hooks.ts';
import type { BarrierLease } from '../src/demo/reset-barrier.ts';
import { createDemoResetGate, DEMO_RESET_RETRY_AFTER_SECONDS } from '../src/demo/reset-gate.ts';
import { DEMO_MESSAGES } from '../src/demo/types.ts';
import { createDemoJobExecutionGuard, DEMO_JOB_DEFER_MS } from '../src/jobs/demo.ts';

/**
 * Phase 14 Final (Reset-Barrier, Design B/C, Unit): Reihenfolge Gate → Shared-
 * Lock → ungecachte Zweitprüfung → Fachrequest, und die Freigabe in allen
 * Antwort-/Abbruchpfaden – ohne Datenbank, mit einer Fake-Barrier, die jede
 * Lease protokolliert. Dazu der Execution-Guard der Jobs auf derselben Fake.
 */

class FakeLease implements BarrierLease {
  readonly mode = 'shared' as const;
  released = false;
  releaseCalls = 0;
  constructor(
    readonly id: number,
    private readonly flag: () => boolean,
    private readonly events: string[],
  ) {}
  async release(): Promise<void> {
    this.releaseCalls += 1;
    if (this.released) return;
    this.released = true;
    this.events.push(`release:${this.id}`);
  }
  async isResetInProgressUncached(): Promise<boolean> {
    this.events.push(`uncached:${this.id}`);
    return this.flag();
  }
}

class FakeBarrier {
  readonly events: string[] = [];
  readonly leases: FakeLease[] = [];
  /** Exclusive gehalten/beantragt ⇒ tryAcquireShared liefert null. */
  exclusive = false;
  /** Wert der ungecachten Zweitprüfung (DB-Wahrheit). */
  resetInProgress = false;
  /** Fehler beim Lock-Erwerb (Lock-Pool/DB nicht erreichbar). */
  acquireError: Error | null = null;

  async tryAcquireShared(): Promise<BarrierLease | null> {
    if (this.acquireError !== null) throw this.acquireError;
    this.events.push('acquire');
    if (this.exclusive) {
      this.events.push('acquire:null');
      return null;
    }
    const lease = new FakeLease(this.leases.length + 1, () => this.resetInProgress, this.events);
    this.leases.push(lease);
    return lease;
  }

  held(): number {
    return this.leases.filter((lease) => !lease.released).length;
  }
}

async function buildApp(options: { gateFlag?: () => boolean; probes?: boolean } = {}) {
  const barrier = new FakeBarrier();
  const gateFlag = options.gateFlag ?? (() => false);
  const gate = createDemoResetGate({
    dataset: { resetInProgress: async () => gateFlag() },
    cacheTtlMs: 0,
  });
  const hooks = createDemoBarrierHooks(barrier);
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    barrier.events.push(`gate:${request.method}`);
    await gate.onRequest(request, reply);
  });
  registerDemoBarrierHooks(app, hooks);
  if (options.probes === true) {
    // Sonden NACH den Barrier-Hooks: zeigen, in welchem Hook die Freigabe liegt.
    app.addHook('onSend', async (_request, _reply, payload) => {
      barrier.events.push('onSend:after');
      return payload;
    });
    app.addHook('onResponse', async () => {
      barrier.events.push('onResponse:after');
    });
  }
  let captured: FastifyRequest | null = null;
  let releaseHandler: (() => void) | null = null;
  app.post('/staff/customers', async (request) => {
    barrier.events.push('handler');
    captured = request;
    const body = request.body as { wait?: boolean; fail?: string } | null;
    if (body?.wait === true) {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
    }
    if (body?.fail === 'throw') throw new Error('Unerwartet');
    if (body?.fail === '400') {
      const error = new Error('Ungültig') as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    }
    return { created: true };
  });
  app.get('/staff/customers', async () => ({ list: true }));
  app.post('/auth/login', async () => ({ login: true }));
  app.post('/staff/demo/reset', async () => ({ reset: true }));
  app.post('/staff/push/subscriptions', async () => ({ push: true }));
  app.post('/staff/offline/lease', async () => ({ lease: true }));
  await app.ready();
  return {
    app,
    barrier,
    hooks,
    capturedRequest: () => captured,
    releaseHandler: () => releaseHandler?.(),
  };
}

describe('Demo-Reset-Barrier – API-Hooks (Phase 14 Final, Unit)', () => {
  it('RB-H1. Reihenfolge Gate → Shared-Lock → ungecachte Zweitprüfung → Fachrequest → Freigabe in onResponse; Lesezugriffe und Ausnahmen erwerben nie einen Lock', async () => {
    const { app, barrier, hooks } = await buildApp();
    const ok = await app.inject({ method: 'POST', url: '/staff/customers', payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(barrier.events).toEqual(['gate:POST', 'acquire', 'uncached:1', 'handler', 'release:1']);
    expect(barrier.held()).toBe(0);
    expect(hooks.activeLeases()).toBe(0);

    barrier.events.length = 0;
    for (const [method, url] of [
      ['GET', '/staff/customers'],
      ['POST', '/auth/login'],
      ['POST', '/staff/demo/reset'], // RB16: die Reset-Route hält nie einen Shared-Lock
      ['POST', '/staff/push/subscriptions'],
      ['POST', '/staff/offline/lease'],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(200);
    }
    expect(barrier.events.filter((event) => event.startsWith('acquire'))).toEqual([]);
    expect(barrier.leases).toHaveLength(1);
    await app.close();
  });

  it('RB-H2. Reset hält/beantragt den Exclusive (Shared nicht erwerbbar) ⇒ 503 DEMO_RESET mit retry-after, Handler läuft nicht, nichts zu freizugeben', async () => {
    const { app, barrier, hooks } = await buildApp();
    barrier.exclusive = true;
    const blocked = await app.inject({ method: 'POST', url: '/staff/customers', payload: {} });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers['retry-after']).toBe(String(DEMO_RESET_RETRY_AFTER_SECONDS));
    expect(blocked.json()).toMatchObject({
      error: { code: 'DEMO_RESET', message: DEMO_MESSAGES.DEMO_RESET },
    });
    expect(barrier.events).toEqual(['gate:POST', 'acquire', 'acquire:null']);
    expect(hooks.activeLeases()).toBe(0);
    await app.close();
  });

  it('RB-H3. Gate sieht (gecacht) false, Zweitprüfung nach dem Lock liest true ⇒ Lock sofort freigegeben, 503 DEMO_RESET, keine Mutation (RB5)', async () => {
    const { app, barrier } = await buildApp();
    barrier.resetInProgress = true; // Gate-Fake bleibt false (stale Cache)
    const blocked = await app.inject({ method: 'POST', url: '/staff/customers', payload: {} });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error.code).toBe('DEMO_RESET');
    expect(barrier.events).toEqual(['gate:POST', 'acquire', 'uncached:1', 'release:1']);
    expect(barrier.held()).toBe(0);
    await app.close();
  });

  it('RB-H4. Gate meldet Reset ⇒ 503 vom Gate, die Barrier wird gar nicht erst angefragt', async () => {
    const { app, barrier } = await buildApp({ gateFlag: () => true });
    const blocked = await app.inject({ method: 'POST', url: '/staff/customers', payload: {} });
    expect(blocked.statusCode).toBe(503);
    expect(barrier.events).toEqual(['gate:POST']);
    await app.close();
  });

  it('RB-H5. Freigabe bei Fachfehler (4xx) und bei Exception (500) – kein Lock-Leak (RB11/RB12)', async () => {
    const { app, barrier, hooks } = await buildApp();
    const bad = await app.inject({
      method: 'POST',
      url: '/staff/customers',
      payload: { fail: '400' },
    });
    expect(bad.statusCode).toBe(400);
    const crashed = await app.inject({
      method: 'POST',
      url: '/staff/customers',
      payload: { fail: 'throw' },
    });
    expect(crashed.statusCode).toBe(500);
    expect(barrier.leases).toHaveLength(2);
    expect(barrier.held()).toBe(0);
    expect(hooks.activeLeases()).toBe(0);
    // onError UND onResponse laufen – release bleibt idempotent (genau eine Freigabe je Lease).
    for (const lease of barrier.leases) expect(lease.released).toBe(true);
    expect(barrier.events.filter((event) => event.startsWith('release:'))).toEqual([
      'release:1',
      'release:2',
    ]);
    await app.close();
  });

  it('RB-H6. Lock-Erwerb scheitert (Lock-Pool/DB) ⇒ fail-closed 503 DATABASE_UNAVAILABLE, Handler läuft nie ohne Barrier', async () => {
    const { app, barrier } = await buildApp();
    const error = new Error('connect ECONNREFUSED 127.0.0.1:5432 user=geheim') as Error & {
      code: string;
    };
    error.code = 'ECONNREFUSED';
    barrier.acquireError = error;
    const response = await app.inject({ method: 'POST', url: '/staff/customers', payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(response.json())).not.toContain('geheim');
    expect(barrier.events).toEqual(['gate:POST']);
    await app.close();
  });

  it('RB-H7 / RB-A2. (Review F1) Client-Abbruch/Timeout während des Handlers: onRequestAbort und onTimeout geben NICHT frei (Handler läuft weiter, Lease bleibt); die Freigabe liegt in onSend nach dem Handlerende – vor dem Schreiben der Antwort und vor onResponse; spätere onResponse/onError sind No-ops (genau eine Freigabe)', async () => {
    const { app, barrier, hooks, capturedRequest, releaseHandler } = await buildApp({
      probes: true,
    });
    const pending = app.inject({
      method: 'POST',
      url: '/staff/customers',
      payload: { wait: true },
    });
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (capturedRequest() !== null) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
    expect(barrier.held()).toBe(1);
    expect(hooks.activeLeases()).toBe(1);
    // Client bricht ab bzw. Timeout: der Handler läuft weiter – die Lease bleibt.
    await hooks.onRequestAbort(capturedRequest()!);
    await hooks.onTimeout(capturedRequest()!, {} as never);
    expect(barrier.held()).toBe(1);
    expect(hooks.activeLeases()).toBe(1);
    expect(barrier.events.filter((event) => event.startsWith('release:'))).toEqual([]);
    // Handlerende ⇒ onSend gibt frei (vor onResponse), Antwort normal.
    releaseHandler();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(barrier.held()).toBe(0);
    expect(hooks.activeLeases()).toBe(0);
    expect(barrier.leases[0]!.releaseCalls).toBe(1);
    expect(barrier.events).toEqual([
      'gate:POST',
      'acquire',
      'uncached:1',
      'handler',
      'release:1',
      'onSend:after',
      'onResponse:after',
    ]);
    // onSend ohne Lease: No-op, Payload unverändert, done synchron (kein verzögertes Senden).
    const payload = { unchanged: true };
    let forwarded: unknown = null;
    hooks.onSend({} as never, {} as never, payload, (error?: Error | null, next?: unknown) => {
      expect(error).toBeNull();
      forwarded = next;
    });
    expect(forwarded).toBe(payload);
    await app.close();
  });
});

describe('Demo-Job-Execution-Guard (Phase 14 Final, Unit)', () => {
  const job = (type: string) => ({
    id: `j-${type}`,
    type,
    payload: {},
    idempotencyKey: type,
    attempts: 1,
    maxAttempts: 5,
    claimedBy: 'w',
  });

  it('RB-J1. alle Jobtypen außer system.heartbeat: Shared-Lock → Zweitprüfung → run mit release; Heartbeat ohne Lock', async () => {
    const barrier = new FakeBarrier();
    const guard = createDemoJobExecutionGuard(barrier);
    for (const type of [
      'mail.send',
      'push.send',
      'communication.scan_due',
      'mail.inbound_poll',
      'communication.cleanup_retention',
      'demo.storage_cleanup',
      'voucher.delivery',
    ]) {
      barrier.events.length = 0;
      const decision = await guard.acquire(job(type));
      expect(decision.action, type).toBe('run');
      expect(barrier.events, type).toEqual(['acquire', `uncached:${barrier.leases.length}`]);
      if (decision.action === 'run') await decision.release();
      expect(barrier.held(), type).toBe(0);
    }
    barrier.events.length = 0;
    const heartbeat = await guard.acquire(job('system.heartbeat'));
    expect(heartbeat.action).toBe('run');
    expect(barrier.events).toEqual([]);
  });

  it('RB-J2. Exclusive gehalten/beantragt ⇒ defer DEMO_RESET (15 s); Zweitprüfung true nach dem Lock ⇒ Lock freigegeben, defer (RB6)', async () => {
    const barrier = new FakeBarrier();
    const guard = createDemoJobExecutionGuard(barrier);
    barrier.exclusive = true;
    expect(await guard.acquire(job('mail.send'))).toEqual({
      action: 'defer',
      delayMs: DEMO_JOB_DEFER_MS,
      reason: 'DEMO_RESET',
    });
    barrier.exclusive = false;
    barrier.resetInProgress = true;
    barrier.events.length = 0;
    expect(await guard.acquire(job('push.send'))).toEqual({
      action: 'defer',
      delayMs: DEMO_JOB_DEFER_MS,
      reason: 'DEMO_RESET',
    });
    expect(barrier.events).toEqual(['acquire', 'uncached:1', 'release:1']);
    expect(barrier.held()).toBe(0);
  });

  it('RB-J3. wirft die Zweitprüfung, wird der Lock freigegeben und der Fehler weitergereicht (Runner vertagt fail-closed)', async () => {
    const barrier = new FakeBarrier();
    const guard = createDemoJobExecutionGuard(barrier);
    const lease = await barrier.tryAcquireShared();
    barrier.tryAcquireShared = async () => {
      (lease as FakeLease).isResetInProgressUncached = async () => {
        throw new Error('DB weg');
      };
      return lease;
    };
    await expect(guard.acquire(job('mail.send'))).rejects.toThrow('DB weg');
    expect((lease as FakeLease).released).toBe(true);
  });
});
