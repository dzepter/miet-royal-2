/**
 * Phase 12 Finalisierung – Pflichttests
 *  P1–P10  Kein Push-Opt-out in Miet-Royal (bestätigte Entscheidung: die
 *          bewusste Entscheidung ist die Browserberechtigung), technische
 *          Deaktivierung bleibt: Logout, Revoke, Inaktivität, Mitarbeiter
 *          deaktiviert, 404, 410, unzulässiger Endpoint, Endpoint-Übernahme.
 *  RA1–RA9 Reassignment-Push-Race: atomarer Claim (CAS) je Zuweisungs-
 *          Version, Zustellung in derselben Transaktion, Job nach Commit,
 *          Push-Outbox-Backstop, kein Doppelpush, Datenminimierung.
 *  P11–P17 Push-Session-Bindung (Review-Befund B1): Session speichert den
 *          Geräte-Hash; erneuter Login desselben Users auf demselben Gerät
 *          bindet das Abo an die neue Session; Statusroute bindet um/meldet
 *          nur eigene, aktive Abos.
 *  RA10–RA12 Versandzeit-Prüfung (B2): überholte 1h-/Kurzfrist-Zustellungen
 *          ⇒ skipped/SUPERSEDED, kein Gateway-Aufruf.
 *  RA13    Kurzfrist-Regel nur für Neuzuweisungen der letzten 24 h (B3).
 *          Phase 12 Finalisierung 2: start_at wandert mit requestedAt (Regel C –
 *          same-day), siehe communication-push-reassignment-effective (KR1–KR12).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  appointmentReminders,
  appointments,
  integrationJobs,
  processes,
  pushDeliveries,
  pushSubscriptions,
  staffSessions,
  staffUsers,
  type DatabaseExecutor,
} from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { and, asc, eq } from 'drizzle-orm';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  derivePushViewState,
  PUSH_ACTIVE_TEXT,
  PUSH_DENIED_TEXT,
  PUSH_ENABLE_LABEL,
} from '../../staff/lib/push-state.ts';
import { sha256Hex } from '../src/auth/crypto.ts';
import { isSessionExpiredByInactivity } from '../src/auth/service.ts';
import { PUSH_ENDPOINT_NOT_ALLOWED } from '../src/communication/push/endpoint-policy.ts';
import { WebPushGateway } from '../src/communication/push/gateways.ts';
import { buildPushPayload } from '../src/communication/push/payload.ts';
import {
  PushService,
  pushSendJobKey,
  type PushEnqueueInput,
  type PushEnqueueResult,
} from '../src/communication/push/push-service.ts';
import {
  pushKeys,
  PushRuleScanner,
  type PushRuleCandidate,
  type PushRuleScannerDeps,
} from '../src/communication/push/rules.ts';
import { createPushSendHandler } from '../src/communication/push/send-job.ts';
import { PushSubscriptionService } from '../src/communication/push/subscription-service.ts';
import { PUSH_SUPERSEDED_CODE } from '../src/communication/push/supersede.ts';
import { PUSH_SEND_JOB_TYPE, type PushGateway } from '../src/communication/types.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';

let ctx: TestContext;
const logChunks: string[] = [];
const logDestination = new Writable({
  write(chunk, _encoding, callback) {
    logChunks.push(String(chunk));
    callback();
  },
});

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'info' });
});
afterAll(async () => {
  await ctx.pool.query('TRUNCATE push_deliveries, push_subscriptions, integration_jobs CASCADE');
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE push_deliveries, push_subscriptions, appointment_reminders, integration_jobs CASCADE',
  );
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.push.reset();
  logChunks.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const MINUTES = 60_000;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;
const KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };
const STAFF_ROOT = join(import.meta.dirname, '..', '..', 'staff');

function endpointFor(label: string): string {
  return `https://push.example.test/send/final-${label}-${'e'.repeat(40)}`;
}

async function subscribe(cookie: string, endpoint: string, label = 'Testgerät') {
  return ctx.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions',
    headers: { cookie },
    payload: { endpoint, keys: KEYS, userAgentLabel: label },
  });
}

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

async function employee(adminId: string, name: string) {
  const password = `${name.toLowerCase()}-passwort-1234`;
  const user = await createEmployeeWithPassword(ctx, adminId, {
    firstName: name,
    lastName: 'Final',
    email: `${name.toLowerCase()}@final.example`,
    password,
  });
  const session = await login(ctx.app, user.email, password);
  // Phase 12 Finalisierung (B1): Passwort + Geräte-Cookie für erneute Logins vom selben Gerät.
  return { user, cookie: session.cookie, password, deviceCookie: session.deviceCookie };
}

function scanner(overrides: Partial<PushRuleScannerDeps> = {}): PushRuleScanner {
  return new PushRuleScanner({
    db: ctx.db,
    push: new PushService(ctx.db, ctx.queue),
    auth: ctx.auth,
    ...overrides,
  });
}

/** Alle fälligen Jobs verarbeiten (JobRunner stoppt im Testmodus nach einem Job). */
async function drainAll(): Promise<void> {
  while ((await ctx.jobs.runOnce()) !== 'idle') {
    // weiter
  }
}

async function deliveriesOf(kind: string) {
  return (await ctx.db.select().from(pushDeliveries)).filter((row) => row.kind === kind);
}

async function subscriptionByEndpoint(endpoint: string) {
  const rows = await ctx.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
  return rows[0];
}

async function pushJobFor(deliveryId: string) {
  return ctx.db
    .select()
    .from(integrationJobs)
    .where(
      and(
        eq(integrationJobs.type, PUSH_SEND_JOB_TYPE),
        eq(integrationJobs.idempotencyKey, pushSendJobKey(deliveryId)),
      ),
    );
}

function sentTo(endpoint: string, kind: string) {
  return ctx.push.forEndpoint(endpoint).filter((record) => record.payload.kind === kind);
}

function capturingLogger(): { logger: JobRunnerLogger; lines: string[] } {
  const lines: string[] = [];
  const write = (level: string) => (context: Record<string, unknown>, message: string) => {
    lines.push(JSON.stringify({ level, message, ...context }));
  };
  return { logger: { info: write('info'), warn: write('warn'), error: write('error') }, lines };
}

async function enqueueTestPush(userId: string, key: string) {
  return new PushService(ctx.db, ctx.queue).enqueue({
    kind: 'substitution_started',
    userId,
    idempotencyKey: key,
    payload: buildPushPayload({ kind: 'substitution_started' }),
  });
}

async function deliveryById(id: string) {
  const rows = await ctx.db.select().from(pushDeliveries).where(eq(pushDeliveries.id, id));
  return rows[0];
}

async function deliveryByKey(key: string) {
  const rows = await ctx.db
    .select()
    .from(pushDeliveries)
    .where(eq(pushDeliveries.idempotencyKey, key));
  return rows[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// P1–P10: kein Push-Opt-out, technische Deaktivierung
// ═══════════════════════════════════════════════════════════════════════════

describe('P1–P4: kein Push-Opt-out (API + Staff-UI)', () => {
  it('P1. Die Abmelde-Route DELETE /staff/push/subscriptions/current existiert nicht (404); es gibt keine andere Opt-out-Route (Routentabelle)', async () => {
    const { cookie } = await adminSession();
    const endpoint = endpointFor('p1');
    expect((await subscribe(cookie, endpoint)).statusCode).toBe(200);
    for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
      const response = await ctx.app.inject({
        method,
        url: '/staff/push/subscriptions/current',
        headers: { cookie },
        payload: { endpoint },
      });
      expect(response.statusCode, method).toBe(404);
    }
    expect(
      (
        await ctx.app.inject({
          method: 'DELETE',
          url: '/staff/push/subscriptions',
          headers: { cookie },
          payload: { endpoint },
        })
      ).statusCode,
    ).toBe(404);
    // Subscription unverändert aktiv.
    expect((await subscriptionByEndpoint(endpoint))!.disabledAt).toBeNull();

    // Routentabelle: kein DELETE/PUT/PATCH unter /staff/push, kein Abmelde-/Opt-out-Pfad.
    expect(ctx.app.hasRoute({ method: 'DELETE', url: '/staff/push/subscriptions/current' })).toBe(
      false,
    );
    for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
      expect(ctx.app.printRoutes({ method, commonPrefix: false }), method).not.toMatch(/push/i);
    }
    expect(ctx.app.printRoutes({ commonPrefix: false })).not.toMatch(
      /unsubscribe|opt-?out|abmelden/i,
    );
    for (const suffix of ['current', 'unsubscribe', 'disable', 'pause', 'mute', 'opt-out']) {
      for (const method of ['POST', 'DELETE', 'PUT', 'PATCH'] as const) {
        expect(
          ctx.app.hasRoute({ method, url: `/staff/push/subscriptions/${suffix}` }),
          `${method} ${suffix}`,
        ).toBe(false);
      }
    }
    // Erwartete Push-Routen (nur Aktivieren, Status, eigene Geräte, VAPID-Key).
    expect(ctx.app.hasRoute({ method: 'POST', url: '/staff/push/subscriptions' })).toBe(true);
    expect(ctx.app.hasRoute({ method: 'GET', url: '/staff/push/subscriptions' })).toBe(true);
    expect(ctx.app.hasRoute({ method: 'POST', url: '/staff/push/subscriptions/status' })).toBe(
      true,
    );
    expect(ctx.app.hasRoute({ method: 'GET', url: '/staff/push/vapid-public-key' })).toBe(true);
    // Der Grund „user_unsubscribed“ ist im Service nicht mehr vorhanden.
    const serviceSource = readFileSync(
      join(import.meta.dirname, '..', 'src', 'communication', 'push', 'subscription-service.ts'),
      'utf8',
    );
    expect(serviceSource).not.toMatch(/'user_unsubscribed'/);
    expect(serviceSource).not.toMatch(/async unsubscribe\(/);
  });

  it('P2. Die Einstellungsseite enthält keinen Ausschalt-/Abmelde-/Pausieren-Button und keinen solchen Text; lib/push.ts kennt kein Abmelden', () => {
    const page = readFileSync(
      join(STAFF_ROOT, 'app', 'einstellungen', 'benachrichtigungen', 'page.tsx'),
      'utf8',
    );
    for (const forbidden of [
      /push-disable/,
      /deaktivier/i,
      /ausschalt/i,
      /abschalt/i,
      /abmelde/i,
      /pausier/i,
      /unsubscribe/i,
      /DELETE/,
      /subscriptions\/current/,
    ]) {
      expect(page, String(forbidden)).not.toMatch(forbidden);
    }
    // Erwartete Test-IDs bleiben, Darstellung kommt aus derivePushViewState.
    for (const testId of ['push-enable', 'push-status', 'push-denied', 'push-device-list']) {
      expect(page).toContain(`data-testid="${testId}"`);
    }
    expect(page).toContain('derivePushViewState');
    const pushLib = readFileSync(join(STAFF_ROOT, 'lib', 'push.ts'), 'utf8');
    expect(pushLib).not.toMatch(/unsubscribe/i);
    expect(pushLib).not.toMatch(/DELETE/);
    expect(pushLib).not.toMatch(/subscriptions\/current/);
    // Keine andere Stelle der Staff-App ruft eine Abmelde-Route auf.
    for (const file of [
      join(STAFF_ROOT, 'app', 'konto', 'page.tsx'),
      join(STAFF_ROOT, 'app', 'einstellungen', 'kommunikation', 'page.tsx'),
      join(STAFF_ROOT, 'public', 'sw.js'),
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/subscriptions\/current|unsubscribeFromPush/);
    }
  });

  it('P3. Aktivieren: POST registriert das Gerät (Status aktiv, Geräteliste, Push kommt an); nach technischem Verlust (410) reaktiviert eine erneute Registrierung', async () => {
    const { admin, cookie } = await adminSession();
    const endpoint = endpointFor('p3');
    const response = await subscribe(cookie, endpoint, 'Windows · Chrome');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subscriptionId: expect.any(String) });
    const status = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions/status',
      headers: { cookie },
      payload: { endpoint },
    });
    expect(status.json()).toEqual({ active: true });
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/push/subscriptions',
      headers: { cookie },
    });
    expect(list.json().devices).toEqual([
      expect.objectContaining({ userAgentLabel: 'Windows · Chrome', currentSession: true }),
    ]);
    expect(list.body).not.toContain(endpoint);
    await enqueueTestPush(admin.id, 'final:p3:first');
    await drainAll();
    expect(sentTo(endpoint, 'substitution_started')).toHaveLength(1);

    // Browser/Dienst hat die Subscription verloren (410) ⇒ technisch deaktiviert …
    ctx.push.setBehaviour(endpoint, 'gone');
    await enqueueTestPush(admin.id, 'final:p3:gone');
    await drainAll();
    expect((await subscriptionByEndpoint(endpoint))!.disabledReason).toBe('gone');
    // … die Statusabfrage zeigt wieder „aktivieren“, erneutes Registrieren reaktiviert.
    const inactive = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions/status',
      headers: { cookie },
      payload: { endpoint },
    });
    expect(inactive.json()).toEqual({ active: false });
    ctx.push.setBehaviour(endpoint, 'sent');
    expect((await subscribe(cookie, endpoint)).statusCode).toBe(200);
    expect(await subscriptionByEndpoint(endpoint)).toMatchObject({
      disabledAt: null,
      disabledReason: null,
    });
    await enqueueTestPush(admin.id, 'final:p3:again');
    await drainAll();
    expect(sentTo(endpoint, 'substitution_started')).toHaveLength(3);
  });

  it('P4. Anzeigezustand (lib/push-state.ts): denied ⇒ „Push ist auf diesem Gerät im Browser nicht aktiviert.“; vor Aktivierung „Push-Benachrichtigungen aktivieren“; aktiv ⇒ Status, nie eine Ausschalt-Aktion', () => {
    expect(PUSH_DENIED_TEXT).toBe('Push ist auf diesem Gerät im Browser nicht aktiviert.');
    expect(PUSH_ENABLE_LABEL).toBe('Push-Benachrichtigungen aktivieren');
    expect(PUSH_ACTIVE_TEXT).toBe('Push ist auf diesem Gerät aktiv.');
    const base = { supported: true, serverEnabled: true, active: false } as const;
    expect(derivePushViewState(null)).toEqual({ kind: 'loading' });
    expect(derivePushViewState({ ...base, permission: 'default' })).toEqual({
      kind: 'inactive',
      actionLabel: 'Push-Benachrichtigungen aktivieren',
    });
    expect(derivePushViewState({ ...base, permission: 'denied' })).toEqual({
      kind: 'denied',
      text: 'Push ist auf diesem Gerät im Browser nicht aktiviert.',
    });
    // Abgelehnt hat Vorrang – auch wenn der Server noch eine Subscription kennt.
    expect(derivePushViewState({ ...base, permission: 'denied', active: true }).kind).toBe(
      'denied',
    );
    expect(derivePushViewState({ ...base, permission: 'granted', active: true })).toEqual({
      kind: 'active',
      text: 'Push ist auf diesem Gerät aktiv.',
    });
    // Berechtigung erteilt, Browser hat die Subscription verloren ⇒ wieder aktivierbar.
    expect(derivePushViewState({ ...base, permission: 'granted' }).kind).toBe('inactive');
    expect(
      derivePushViewState({
        supported: false,
        permission: 'unsupported',
        serverEnabled: true,
        active: false,
      }).kind,
    ).toBe('unsupported');
    expect(derivePushViewState({ ...base, permission: 'default', serverEnabled: false }).kind).toBe(
      'server_disabled',
    );
    // Kein Zustand bietet eine Ausschalt-/Abmelde-Aktion an.
    const states = [
      derivePushViewState({ ...base, permission: 'granted', active: true }),
      derivePushViewState({ ...base, permission: 'default' }),
      derivePushViewState({ ...base, permission: 'denied' }),
    ];
    for (const state of states) {
      expect(JSON.stringify(state)).not.toMatch(/deaktiv|ausschalt|abmeld|pausier|disable/i);
    }
  });
});

describe('P5–P9: technische Deaktivierung bleibt', () => {
  it('P5. Logout ⇒ Subscription technisch deaktiviert (session_revoked), kein Push mehr an das Gerät', async () => {
    const { admin, cookie } = await adminSession();
    const endpoint = endpointFor('p5');
    await subscribe(cookie, endpoint);
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect((await subscriptionByEndpoint(endpoint))!.disabledReason).toBe('session_revoked');
    await enqueueTestPush(admin.id, 'final:p5');
    await drainAll();
    expect(ctx.push.forEndpoint(endpoint)).toHaveLength(0);
    expect(await deliveryByKey('final:p5')).toMatchObject({
      status: 'failed',
      lastErrorCode: 'NO_SUBSCRIPTIONS',
    });
  });

  it('P6. Session-Revoke (Admin) ⇒ deaktiviert; Session-Inaktivität (isSessionExpiredByInactivity) ⇒ kein Push (session_expired)', async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const bernd = await employee(admin.id, 'Bernd');
    const revokedEndpoint = endpointFor('p6-revoked');
    await subscribe(bernd.cookie, revokedEndpoint);
    const [berndSession] = await ctx.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.userId, bernd.user.id));
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/staff/sessions/${berndSession!.id}/revoke`,
      headers: { cookie: adminCookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect((await subscriptionByEndpoint(revokedEndpoint))!.disabledReason).toBe('session_revoked');
    await enqueueTestPush(bernd.user.id, 'final:p6:revoked');
    await drainAll();
    expect(ctx.push.forEndpoint(revokedEndpoint)).toHaveLength(0);

    // Inaktivität: Session nie wieder vorgezeigt (nicht widerrufen), aber > 30 Tage alt.
    const carla = await employee(admin.id, 'Carla');
    const staleEndpoint = endpointFor('p6-stale');
    await subscribe(carla.cookie, staleEndpoint);
    const staleAt = new Date(Date.now() - 31 * DAYS);
    expect(isSessionExpiredByInactivity(staleAt, new Date())).toBe(true);
    await ctx.db
      .update(staffSessions)
      .set({ lastActivityAt: staleAt })
      .where(eq(staffSessions.userId, carla.user.id));
    await enqueueTestPush(carla.user.id, 'final:p6:stale');
    await drainAll();
    expect(ctx.push.forEndpoint(staleEndpoint)).toHaveLength(0);
    expect((await subscriptionByEndpoint(staleEndpoint))!.disabledReason).toBe('session_expired');
  });

  async function productionHandlerFor(endpointLabel: string) {
    const { admin, cookie } = await adminSession();
    const endpoint = `https://fcm.googleapis.com/fcm/send/final-${endpointLabel}-${'t'.repeat(40)}`;
    expect((await subscribe(cookie, endpoint)).statusCode).toBe(200);
    const vapid = webpush.generateVAPIDKeys();
    const handler = createPushSendHandler({
      db: ctx.db,
      subscriptions: new PushSubscriptionService(ctx.db),
      gateway: new WebPushGateway(
        { subject: 'mailto:it@miet-royal.example', ...vapid },
        { appEnv: 'production' },
      ),
    });
    const run = async (key: string) => {
      const { deliveryId } = await new PushService(ctx.db, ctx.queue).createDelivery({
        kind: 'substitution_started',
        userId: admin.id,
        idempotencyKey: key,
        payload: buildPushPayload({ kind: 'substitution_started' }),
      });
      await handler({
        id: key,
        type: PUSH_SEND_JOB_TYPE,
        payload: { deliveryId },
        idempotencyKey: key,
        attempts: 1,
        maxAttempts: 5,
        claimedBy: 'final',
      });
      return deliveryId;
    };
    return { endpoint, run };
  }

  for (const [label, statusCode] of [
    ['P7', 404],
    ['P8', 410],
  ] as const) {
    it(`${label}. Push-Dienst antwortet ${statusCode} (echtes WebPushGateway, Versand gemockt) ⇒ Subscription technisch deaktiviert (gone), danach nie wieder angesprochen`, async () => {
      const { endpoint, run } = await productionHandlerFor(`p${statusCode}`);
      const send = vi.spyOn(webpush, 'sendNotification').mockRejectedValueOnce(
        Object.assign(new Error(`Received unexpected response code ${endpoint}`), {
          statusCode,
        }),
      );
      const deliveryId = await run(`final:${label}:first`);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await subscriptionByEndpoint(endpoint))!.disabledReason).toBe('gone');
      const [row] = await ctx.db
        .select()
        .from(pushDeliveries)
        .where(eq(pushDeliveries.id, deliveryId));
      expect(row).toMatchObject({ status: 'failed', lastErrorCode: 'GONE' });
      await run(`final:${label}:second`);
      expect(send).toHaveBeenCalledTimes(1);
    });
  }

  it('P8b. Unzulässiger Endpoint (endpoint-policy) ⇒ kein Verbindungsaufbau, Subscription deaktiviert (endpoint_not_allowed)', async () => {
    const { admin, cookie } = await adminSession();
    const endpoint = endpointFor('p8b'); // im development-Testkontext registrierbar, in production unzulässig
    await subscribe(cookie, endpoint);
    const send = vi.spyOn(webpush, 'sendNotification');
    const vapid = webpush.generateVAPIDKeys();
    const handler = createPushSendHandler({
      db: ctx.db,
      subscriptions: new PushSubscriptionService(ctx.db),
      gateway: new WebPushGateway(
        { subject: 'mailto:it@miet-royal.example', ...vapid },
        { appEnv: 'production' },
      ),
    });
    const { deliveryId } = await new PushService(ctx.db, ctx.queue).createDelivery({
      kind: 'substitution_started',
      userId: admin.id,
      idempotencyKey: 'final:p8b',
      payload: buildPushPayload({ kind: 'substitution_started' }),
    });
    await handler({
      id: 'p8b',
      type: PUSH_SEND_JOB_TYPE,
      payload: { deliveryId },
      idempotencyKey: 'p8b',
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'final',
    });
    expect(send).not.toHaveBeenCalled();
    expect((await subscriptionByEndpoint(endpoint))!.disabledReason).toBe('endpoint_not_allowed');
    expect((await deliveryByKey('final:p8b'))!.lastErrorCode).toBe(PUSH_ENDPOINT_NOT_ALLOWED);
  });

  it('P8c. Endpoint-Übernahme: registriert ein anderer User denselben Browser-Endpoint, erreicht der alte User das Gerät nicht mehr', async () => {
    const { admin, cookie } = await adminSession();
    const anna = await employee(admin.id, 'Anna');
    const endpoint = endpointFor('p8c');
    await subscribe(cookie, endpoint, 'Admin-Gerät');
    await subscribe(anna.cookie, endpoint, 'Annas Gerät');
    expect((await subscriptionByEndpoint(endpoint))!.userId).toBe(anna.user.id);
    await enqueueTestPush(admin.id, 'final:p8c:admin');
    await drainAll();
    expect(sentTo(endpoint, 'substitution_started')).toHaveLength(0);
    expect((await deliveryByKey('final:p8c:admin'))!.lastErrorCode).toBe('NO_SUBSCRIPTIONS');
  });

  it('P9. Deaktivierter Mitarbeiter bekommt keinen Push (Listener deaktiviert sofort; Versand prüft lazy user_inactive); Kurzfrist-Push an Deaktivierte: RA8 (c)', async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const bernd = await employee(admin.id, 'Bernd');
    const endpoint = endpointFor('p9');
    await subscribe(bernd.cookie, endpoint);
    const disable = await ctx.app.inject({
      method: 'POST',
      url: `/staff/users/${bernd.user.id}/status`,
      headers: { cookie: adminCookie },
      payload: { status: 'disabled' },
    });
    expect([200, 204]).toContain(disable.statusCode);
    expect((await subscriptionByEndpoint(endpoint))!.disabledAt).not.toBeNull();
    await enqueueTestPush(bernd.user.id, 'final:p9');
    await drainAll();
    expect(ctx.push.forEndpoint(endpoint)).toHaveLength(0);

    // Lazy-Backstop ohne Listener: Status direkt in der DB auf disabled, Subscription noch aktiv.
    const carla = await employee(admin.id, 'Carla');
    const carlaEndpoint = endpointFor('p9-lazy');
    await subscribe(carla.cookie, carlaEndpoint);
    await ctx.db
      .update(staffUsers)
      .set({ status: 'disabled' })
      .where(eq(staffUsers.id, carla.user.id));
    await enqueueTestPush(carla.user.id, 'final:p9:lazy');
    await drainAll();
    expect(ctx.push.forEndpoint(carlaEndpoint)).toHaveLength(0);
    expect((await subscriptionByEndpoint(carlaEndpoint))!.disabledReason).toBe('user_inactive');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RA1–RA9: Reassignment-Race
// ═══════════════════════════════════════════════════════════════════════════

/** Durchführung morgen 10:00 UTC (11:00/12:00 Berlin); Neuzuweisungen am selben Berliner Tag. */
function tomorrowAt(hourUtc: number): Date {
  const day = new Date(Date.now() + DAYS);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc));
}
const START_AT = tomorrowAt(10);
const ASSIGN_AT = tomorrowAt(6); // 07:00/08:00 Berlin – gleicher Kalendertag

async function reassignmentWorld() {
  const { admin, cookie: adminCookie } = await adminSession();
  const anna = await employee(admin.id, 'Anna');
  const bernd = await employee(admin.id, 'Bernd');
  const carla = await employee(admin.id, 'Carla');
  const world = await createAcceptedBooking(ctx, admin.id, { assignProcessTo: anna.user.id });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  const pickup = rows.find((row) => row.kind === 'pickup')!;
  await scheduling.reschedule(admin.id, pickup.id, {
    startAt: START_AT,
    endAt: null,
    expectedVersion: pickup.version,
  });
  const effective = await ctx.auth.effectivePermissions(admin.id);
  /** Neuzuweisung am Durchführungstag (`offsetMinutes` nach ASSIGN_AT). */
  const assignTo = async (userId: string, offsetMinutes = 0) => {
    const current = await scheduling.byId(pickup.id);
    return scheduling.assign(
      admin.id,
      pickup.id,
      { userId, expectedVersion: current.version },
      effective,
      new Date(ASSIGN_AT.getTime() + offsetMinutes * MINUTES),
    );
  };
  const endpoints = {
    anna: endpointFor('ra-anna'),
    bernd: endpointFor('ra-bernd'),
    carla: endpointFor('ra-carla'),
  };
  await subscribe(anna.cookie, endpoints.anna);
  await subscribe(bernd.cookie, endpoints.bernd);
  await subscribe(carla.cookie, endpoints.carla);
  const current = () => scheduling.byId(pickup.id);
  return {
    admin,
    adminCookie,
    anna,
    bernd,
    carla,
    world,
    pickupId: pickup.id,
    assignTo,
    endpoints,
    current,
  };
}

const REASSIGNED = 'assignment_reassigned';
const reassignedDeliveries = () => deliveriesOf(REASSIGNED);

describe('RA1–RA9: Reassignment-Push mit atomarem Claim', () => {
  it('RA1. Neuzuweisung Anna → Bernd ⇒ genau ein Push an Bernd (Schlüssel je Termin/requestedAt/Person), danach markiert; Folgescans no-op', async () => {
    const w = await reassignmentWorld();
    const assigned = await w.assignTo(w.bernd.user.id);
    expect(assigned.acknowledgementRequestedFor).toBe(w.bernd.user.id);
    const now = new Date();
    expect(await scanner().scanSameDayReassignments(now)).toBe(1);
    const rows = await reassignedDeliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: w.bernd.user.id,
      idempotencyKey: pushKeys.reassignment(
        w.pickupId,
        assigned.acknowledgementRequestedAt!,
        w.bernd.user.id,
      ),
    });
    expect((await w.current()).assignmentNotifiedAt).not.toBeNull();
    expect(await pushJobFor(rows[0]!.id)).toHaveLength(1);
    expect(await scanner().scanSameDayReassignments(new Date(now.getTime() + MINUTES))).toBe(0);
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
    expect(sentTo(w.endpoints.anna, REASSIGNED)).toHaveLength(0);
    expect(await reassignedDeliveries()).toHaveLength(1);
  });

  it('RA2. Bernd → Carla VOR dem Claim ⇒ kein Push an Bernd, genau einer an Carla', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id, 0);
    await w.assignTo(w.carla.user.id, 1);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const rows = await reassignedDeliveries();
    expect(rows.map((row) => row.userId)).toEqual([w.carla.user.id]);
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(0);
    expect(sentTo(w.endpoints.carla, REASSIGNED)).toHaveLength(1);
  });

  it('RA3. Wechsel Bernd → Carla GENAU zwischen Lesen und Claim (Testhook) ⇒ Claim scheitert, kein Push an Bernd; nächster Scan ⇒ Carla; Claim mit veralteten Werten ⇒ null', async () => {
    const w = await reassignmentWorld();
    const berndAssignment = await w.assignTo(w.bernd.user.id, 0);
    const seen: PushRuleCandidate[] = [];
    let switched = false;
    const racing = scanner({
      onCandidateRead: async (candidate) => {
        seen.push(candidate);
        if (candidate.rule === 'assignment_reassigned' && !switched) {
          switched = true;
          await w.assignTo(w.carla.user.id, 1); // zwischen Read und Claim
        }
      },
    });
    expect(await racing.scanSameDayReassignments(new Date())).toBe(0);
    expect(seen).toEqual([{ rule: 'assignment_reassigned', appointmentId: w.pickupId }]);
    expect(await reassignedDeliveries()).toHaveLength(0);
    const afterRace = await w.current();
    expect(afterRace.assignmentNotifiedAt).toBeNull();
    expect(afterRace.acknowledgementRequestedFor).toBe(w.carla.user.id);

    // Direkter Claim mit den veralteten (Bernd-)Werten scheitert ebenfalls.
    expect(
      await scanner().claimReassignment(
        {
          appointmentId: w.pickupId,
          requestedAt: berndAssignment.acknowledgementRequestedAt!,
          requestedFor: w.bernd.user.id,
        },
        new Date(),
      ),
    ).toBeNull();
    expect((await w.current()).assignmentNotifiedAt).toBeNull();

    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    expect((await reassignedDeliveries()).map((row) => row.userId)).toEqual([w.carla.user.id]);
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(0);
    expect(sentTo(w.endpoints.carla, REASSIGNED)).toHaveLength(1);
  });

  it('RA3b. (1h-Regel, gleiches Muster) Zuständigkeit wechselt zwischen Lesen und Markieren ⇒ kein 1h-Push an die alte Person; der nächste Scan erreicht die neue', async () => {
    const { admin } = await adminSession();
    const anna = await employee(admin.id, 'Anna');
    const bernd = await employee(admin.id, 'Bernd');
    const world = await createAcceptedBooking(ctx, admin.id, { assignProcessTo: anna.user.id });
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const [pickup] = await ctx.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.bookingId, world.bookingId), eq(appointments.kind, 'pickup')));
    const startAt = new Date(Date.now() + 30 * MINUTES);
    await scheduling.reschedule(admin.id, pickup!.id, {
      startAt,
      endAt: null,
      expectedVersion: pickup!.version,
    });
    const effective = await ctx.auth.effectivePermissions(admin.id);
    let switched = false;
    const racing = scanner({
      onCandidateRead: async (candidate) => {
        if (candidate.rule === 'appointment_1h' && !switched) {
          switched = true;
          const current = await scheduling.byId(pickup!.id);
          await scheduling.assign(
            admin.id,
            pickup!.id,
            { userId: bernd.user.id, expectedVersion: current.version },
            effective,
            new Date(startAt.getTime() - 2 * HOURS),
          );
        }
      },
    });
    const now = new Date();
    expect(await racing.scanAppointmentReminders(now)).toBe(0);
    expect(await deliveriesOf('appointment_1h')).toHaveLength(0);
    expect(await ctx.db.select().from(appointmentReminders)).toHaveLength(0);
    expect(await scanner().scanAppointmentReminders(now)).toBe(1);
    const rows = await deliveriesOf('appointment_1h');
    expect(rows.map((row) => row.userId)).toEqual([bernd.user.id]);
    expect(await pushJobFor(rows[0]!.id)).toHaveLength(1);
  });

  it('RA4. Fehler nach dem Claim vor der Zustellung (PushService wirft) ⇒ Rollback inkl. Claim; nächster Scan holt genau einmal nach; Log nur IDs/Code', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id);
    class ThrowingPushService extends PushService {
      override async createDelivery(
        input: PushEnqueueInput,
        executor?: DatabaseExecutor,
      ): Promise<PushEnqueueResult> {
        // Zeile wird in der Claim-Transaktion angelegt – danach scheitert der Schritt.
        await super.createDelivery(input, executor);
        throw new Error(`enqueue kaputt ${KEYS.auth}`);
      }
    }
    const { logger, lines } = capturingLogger();
    const failing = scanner({ push: new ThrowingPushService(ctx.db, ctx.queue), logger });
    const pushJobs = async () =>
      (await ctx.db.select().from(integrationJobs)).filter((job) => job.type === PUSH_SEND_JOB_TYPE)
        .length;
    const jobsBefore = await pushJobs();
    expect(await failing.scanSameDayReassignments(new Date())).toBe(0);
    // Rollback: weder Claim noch Zustellungszeile noch Job.
    expect((await w.current()).assignmentNotifiedAt).toBeNull();
    expect(await reassignedDeliveries()).toHaveLength(0);
    expect(await pushJobs()).toBe(jobsBefore);
    const warn = lines.find((line) => line.includes('nächster Scan holt nach'));
    expect(warn).toBeDefined();
    expect(JSON.parse(warn!)).toMatchObject({
      level: 'warn',
      rule: 'assignment_reassigned',
      appointmentId: w.pickupId,
      errorCode: 'Error',
    });
    expect(lines.join('\n')).not.toContain(KEYS.auth);
    expect(lines.join('\n')).not.toContain('enqueue kaputt');

    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    expect((await reassignedDeliveries()).map((row) => row.userId)).toEqual([w.bernd.user.id]);
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
    expect((await w.current()).assignmentNotifiedAt).not.toBeNull();
  });

  it('RA5. Absturz nach dem Commit vor dem Job ⇒ Outbox-Backstop reiht genau einen Job nach (stabiler Schlüssel), genau ein Push; push.send ist für gesendete Zustellungen ein No-op', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id);
    class CrashAfterCommit extends PushService {
      override async enqueueSendJob(): Promise<boolean> {
        throw new Error('Prozess beendet');
      }
    }
    const crashing = scanner({ push: new CrashAfterCommit(ctx.db, ctx.queue) });
    // Zustellung ist committed (zählt), nur der Job fehlt.
    expect(await crashing.scanSameDayReassignments(new Date())).toBe(1);
    const [delivery] = await reassignedDeliveries();
    expect(delivery).toMatchObject({ userId: w.bernd.user.id, status: 'pending' });
    expect((await w.current()).assignmentNotifiedAt).not.toBeNull();
    expect(await pushJobFor(delivery!.id)).toHaveLength(0);

    // Nächster regulärer Lauf: Claim scheitert (bereits markiert), Backstop holt den Job nach.
    const summary = await scanner().scanDue(new Date());
    expect(summary.reassignment).toBe(0);
    expect(summary.outboxBackstop).toBe(1);
    expect(await pushJobFor(delivery!.id)).toHaveLength(1);
    expect((await scanner().scanDue(new Date())).outboxBackstop).toBe(0);
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
    expect((await deliveryById(delivery!.id))!.status).toBe('sent');

    // Erneute Ausführung des Jobs (at-least-once) ⇒ No-op, kein zweiter Push.
    const handler = createPushSendHandler({
      db: ctx.db,
      subscriptions: new PushSubscriptionService(ctx.db),
      gateway: ctx.push,
    });
    await handler({
      id: 'replay',
      type: PUSH_SEND_JOB_TYPE,
      payload: { deliveryId: delivery!.id },
      idempotencyKey: 'replay',
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'final',
    });
    expect((await scanner().scanDue(new Date())).outboxBackstop).toBe(0);
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
    expect(await reassignedDeliveries()).toHaveLength(1);
  });

  it('RA5b. Altbestand (alter Ablauf: Zustellung + Job eingereiht, Absturz vor der Markierung) ⇒ Claim dedupliziert über den Schlüssel, kein zweiter Push', async () => {
    const w = await reassignmentWorld();
    const assigned = await w.assignTo(w.bernd.user.id);
    const key = pushKeys.reassignment(
      w.pickupId,
      assigned.acknowledgementRequestedAt!,
      w.bernd.user.id,
    );
    const legacy = await new PushService(ctx.db, ctx.queue).enqueue({
      kind: 'assignment_reassigned',
      userId: w.bernd.user.id,
      idempotencyKey: key,
      payload: buildPushPayload({
        kind: 'assignment_reassigned',
        processId: w.world.processId,
        processNumber: (
          await ctx.db
            .select({ number: processes.processNumber })
            .from(processes)
            .where(eq(processes.id, w.world.processId))
        )[0]!.number,
        appointmentKind: 'pickup',
      }),
    });
    expect((await w.current()).assignmentNotifiedAt).toBeNull();
    const counts = await Promise.all([
      scanner().scanSameDayReassignments(new Date()),
      scanner().scanSameDayReassignments(new Date()),
    ]);
    expect(counts).toEqual([0, 0]); // dedupliziert – keine NEUE Zustellung
    expect((await reassignedDeliveries()).map((row) => row.id)).toEqual([legacy.deliveryId]);
    expect(await pushJobFor(legacy.deliveryId)).toHaveLength(1);
    expect((await w.current()).assignmentNotifiedAt).not.toBeNull();
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
  });

  it('RA6. Parallele Scanner (Promise.all über scanDue) ⇒ genau ein push_deliveries-Eintrag und genau ein Push', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id);
    const now = new Date();
    const summaries = await Promise.all(Array.from({ length: 5 }, () => scanner().scanDue(now)));
    expect(summaries.reduce((sum, summary) => sum + summary.reassignment, 0)).toBe(1);
    const rows = await reassignedDeliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(w.bernd.user.id);
    expect(await pushJobFor(rows[0]!.id)).toHaveLength(1);
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
  });

  it('RA6b. Claim und Neuzuweisung parallel ⇒ nie ein Push an jemanden, der beim Claim nicht zuständig war; Carla erhält genau einen; Bernd (B2: Versandzeit-Prüfung) deterministisch keinen', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id, 0);
    await Promise.all([
      scanner().scanSameDayReassignments(new Date()),
      w.assignTo(w.carla.user.id, 1),
      scanner().scanSameDayReassignments(new Date()),
    ]);
    await scanner().scanSameDayReassignments(new Date());
    const rows = await reassignedDeliveries();
    // Zustellungszeile für Bernd höchstens einmal (nur wenn sein Claim VOR der Neuzuweisung
    // committed war), Carla genau einmal.
    expect(rows.filter((row) => row.userId === w.carla.user.id)).toHaveLength(1);
    expect(rows.filter((row) => row.userId === w.bernd.user.id).length).toBeLessThanOrEqual(1);
    expect(rows.filter((row) => row.userId === w.anna.user.id)).toHaveLength(0);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(rows.length);
    // Phase 12 Finalisierung (B2): beim Versand ist Carla zuständig ⇒ eine evtl. Bernd-
    // Zustellung ist überholt – Bernd erhält NIE einen Push (vorher: „höchstens einmal“).
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(0);
    expect(sentTo(w.endpoints.carla, REASSIGNED)).toHaveLength(1);
    for (const row of (await reassignedDeliveries()).filter(
      (delivery) => delivery.userId === w.bernd.user.id,
    )) {
      expect(row).toMatchObject({ status: 'skipped', lastErrorCode: PUSH_SUPERSEDED_CODE });
    }
  });

  it('RA7. Spätere erneute Neuzuweisung ⇒ neuer Push an die neue Person (auch zurück an Bernd: neuer requestedAt ⇒ neuer Anspruch)', async () => {
    const w = await reassignmentWorld();
    // Phase 12 Finalisierung (B2): push.send läuft jeweils, solange die Zuweisung
    // aktuell ist (überholte Zustellungen sendet die Versandzeit-Prüfung nicht – RA10).
    await w.assignTo(w.bernd.user.id, 0);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    await w.assignTo(w.carla.user.id, 5);
    expect((await w.current()).assignmentNotifiedAt).toBeNull();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    await w.assignTo(w.bernd.user.id, 10);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    const rows = await reassignedDeliveries();
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [w.bernd.user.id, w.bernd.user.id, w.carla.user.id].sort(),
    );
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(3);
    await drainAll();
    expect((await reassignedDeliveries()).every((row) => row.status === 'sent')).toBe(true);
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(2);
    expect(sentTo(w.endpoints.carla, REASSIGNED)).toHaveLength(1);
    expect(sentTo(w.endpoints.anna, REASSIGNED)).toHaveLength(0);
  });

  it('RA8. Storno VOR dem Claim ⇒ Claim scheitert (status ≠ scheduled), kein Push, nie wieder Kandidat; Vorgang storniert bei offenem Termin ⇒ Claim ohne Push; inaktiver Empfänger ⇒ Claim ohne Push', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id);
    const scheduling = schedulingServiceFor(ctx);
    const racing = scanner({
      onCandidateRead: async () => {
        // Storno-Transaktion (Termine des Vorgangs unter Sperre stornieren) zwischen Read und Claim.
        await ctx.db.transaction(async (tx) => {
          await scheduling.cancelForProcessWithin(tx, w.world.processId, new Date());
          await tx
            .update(processes)
            .set({ mainStatus: 'cancelled' })
            .where(eq(processes.id, w.world.processId));
        });
      },
    });
    expect(await racing.scanSameDayReassignments(new Date())).toBe(0);
    expect(await reassignedDeliveries()).toHaveLength(0);
    const cancelled = await w.current();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.assignmentNotifiedAt).toBeNull();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect(await reassignedDeliveries()).toHaveLength(0);

    // (b) Vorgang storniert, Termin (noch) geplant ⇒ geclaimt, bewusst ohne Push.
    const v = await reassignmentWorld2();
    await v.assignTo(v.bernd.user.id);
    await ctx.db
      .update(processes)
      .set({ mainStatus: 'cancelled' })
      .where(eq(processes.id, v.processId));
    const claimB = await scanner().claimReassignment(
      {
        appointmentId: v.pickupId,
        requestedAt: (await v.current()).acknowledgementRequestedAt!,
        requestedFor: v.bernd.user.id,
      },
      new Date(),
    );
    expect(claimB).toEqual({ deliveryId: null, skipped: 'process_cancelled' });
    expect((await v.current()).assignmentNotifiedAt).not.toBeNull();

    // (c) Empfänger inzwischen deaktiviert ⇒ geclaimt (nicht endlos gescannt), kein Push.
    const u = await reassignmentWorld2('c');
    await u.assignTo(u.bernd.user.id);
    await ctx.db
      .update(staffUsers)
      .set({ status: 'disabled' })
      .where(eq(staffUsers.id, u.bernd.user.id));
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect((await u.current()).assignmentNotifiedAt).not.toBeNull();
    expect(await reassignedDeliveries()).toHaveLength(0);
    await drainAll();
    expect(ctx.push.sent.filter((record) => record.payload.kind === REASSIGNED)).toHaveLength(0);
  });

  it('RA9. Datenminimierung: Nutzlast nur {kind,title,body,url,tag} mit Terminart + Vorgangsnummer; Schlüssel nur IDs/Zeitpunkt; keine Kundendaten in Nutzlast, Logs oder Fehlercodes', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id);
    const { logger, lines } = capturingLogger();
    expect(await scanner({ logger }).scanDue(new Date())).toMatchObject({ reassignment: 1 });
    const [row] = await reassignedDeliveries();
    expect(Object.keys(row!.payload as object).sort()).toEqual([
      'body',
      'kind',
      'tag',
      'title',
      'url',
    ]);
    expect(row!.payload).toMatchObject({
      kind: 'assignment_reassigned',
      title: 'Kurzfristig zugewiesen',
      url: `/vorgaenge/${w.world.processId}/termine`,
    });
    expect((row!.payload as { body: string }).body).toMatch(
      /^Abholung MR-\d{4}-\d{4,} – in Miet-Royal prüfen$/,
    );
    expect(row!.idempotencyKey).toMatch(
      /^push:assignment_reassigned:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}T[\d:.]+Z:[0-9a-f-]{36}$/,
    );
    await drainAll();
    const [sent] = sentTo(w.endpoints.bernd, REASSIGNED);
    const serialized = [
      JSON.stringify(row),
      JSON.stringify(sent!.payload),
      lines.join('\n'),
      logChunks.join(''),
    ].join('\n');
    for (const forbidden of ['Klara', 'Kommerz', '9998877', 'klara.kommerz', 'Lieferweg', '€']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    // Server-/Scanner-Log enthält nie Endpoint oder Schlüssel.
    const logs = `${lines.join('\n')}\n${logChunks.join('')}`;
    for (const endpoint of Object.values(w.endpoints)) expect(logs).not.toContain(endpoint);
    expect(logs).not.toContain(KEYS.auth);
    expect(logs).not.toContain(KEYS.p256dh);
  });
});

/** Zweite, unabhängige Welt (eigener Vorgang/eigene Mitarbeitende) in derselben DB. */
async function reassignmentWorld2(suffix = 'b') {
  const [admin] = await ctx.db.select().from(staffUsers).where(eq(staffUsers.email, ADMIN_EMAIL));
  const bernd = await employee(admin!.id, `Bernd${suffix}`);
  const anna = await employee(admin!.id, `Anna${suffix}`);
  const world = await createAcceptedBooking(ctx, admin!.id, { assignProcessTo: anna.user.id });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const [pickup] = await ctx.db
    .select()
    .from(appointments)
    .where(and(eq(appointments.bookingId, world.bookingId), eq(appointments.kind, 'pickup')));
  await scheduling.reschedule(admin!.id, pickup!.id, {
    startAt: START_AT,
    endAt: null,
    expectedVersion: pickup!.version,
  });
  const effective = await ctx.auth.effectivePermissions(admin!.id);
  return {
    bernd,
    processId: world.processId,
    pickupId: pickup!.id,
    current: () => scheduling.byId(pickup!.id),
    assignTo: async (userId: string) => {
      const current = await scheduling.byId(pickup!.id);
      return scheduling.assign(
        admin!.id,
        pickup!.id,
        { userId, expectedVersion: current.version },
        effective,
        ASSIGN_AT,
      );
    },
  };
}

describe('P10: bestehende Push-Regeln bleiben grün (Regression im selben Lauf)', () => {
  it('P10. scanDue: 1h-Push + Kurzfrist-Push je genau einmal, zweiter Lauf no-op, Backstop ohne Arbeit, solange alle Jobs existieren', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id);
    // Zusätzlich ein 1h-Termin (Rückgabe in 30 min) für Anna.
    const scheduling = schedulingServiceFor(ctx);
    const [ret] = await ctx.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.bookingId, w.world.bookingId), eq(appointments.kind, 'return')));
    const returnAt = new Date(Date.now() + 30 * MINUTES);
    await scheduling.reschedule(w.admin.id, ret!.id, {
      startAt: returnAt,
      endAt: null,
      expectedVersion: ret!.version,
    });
    const now = new Date();
    const first = await scanner().scanDue(now);
    expect(first).toMatchObject({ appointment1h: 1, reassignment: 1, outboxBackstop: 0 });
    const second = await scanner().scanDue(new Date(now.getTime() + 2 * MINUTES));
    expect(second).toMatchObject({ appointment1h: 0, reassignment: 0, outboxBackstop: 0 });
    expect(await deliveriesOf('appointment_1h')).toHaveLength(1);
    expect((await deliveriesOf('appointment_1h'))[0]!.userId).toBe(w.anna.user.id);
    expect(await reassignedDeliveries()).toHaveLength(1);
    await drainAll();
    expect(sentTo(w.endpoints.anna, 'appointment_1h')).toHaveLength(1);
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P11–P17: Push-Session-Bindung (Review-Befund B1)
// ═══════════════════════════════════════════════════════════════════════════

async function sessionsOf(userId: string) {
  return ctx.db
    .select()
    .from(staffSessions)
    .where(eq(staffSessions.userId, userId))
    .orderBy(asc(staffSessions.createdAt));
}

async function pushStatus(cookie: string, endpoint: string): Promise<boolean> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/push/subscriptions/status',
    headers: { cookie },
    payload: { endpoint },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { active: boolean }).active;
}

function deviceHashOf(deviceCookie: string): string {
  expect(deviceCookie.startsWith('mr_staff_device=')).toBe(true);
  return sha256Hex(deviceCookie.slice('mr_staff_device='.length));
}

/**
 * Bernd meldet sich an (S1, Geräte-Cookie D), registriert Push und meldet sich
 * auf demselben Gerät erneut an (S2, gleiches D) – z. B. weil das Session-
 * Cookie nach festen 30 Tagen abgelaufen ist; S1 bleibt serverseitig gültig.
 */
async function reloginWorld(label: string) {
  const { admin, cookie: adminCookie } = await adminSession();
  const bernd = await employee(admin.id, 'Bernd');
  const endpoint = endpointFor(label);
  expect((await subscribe(bernd.cookie, endpoint)).statusCode).toBe(200);
  const [s1] = await sessionsOf(bernd.user.id);
  expect((await subscriptionByEndpoint(endpoint))!.sessionId).toBe(s1!.id);
  const second = await login(ctx.app, bernd.user.email, bernd.password, undefined, {
    deviceCookie: bernd.deviceCookie,
  });
  expect(second.statusCode).toBe(200);
  const s2 = (await sessionsOf(bernd.user.id)).find((session) => session.id !== s1!.id)!;
  return { admin, adminCookie, bernd, endpoint, s1Id: s1!.id, s2Id: s2.id, second };
}

describe('P11–P17: Push-Abo folgt der Session desselben Geräts (B1)', () => {
  it('P11. Erneuter Login mit demselben Geräte-Cookie (S2, S1 bleibt gültig) ⇒ Subscription an S2 gebunden; beide Sessions tragen nur den SHA-256; kein Hash in API-Antworten', async () => {
    const w = await reloginWorld('p11');
    expect(w.second.deviceCookie).toBe(w.bernd.deviceCookie);
    const sessions = await sessionsOf(w.bernd.user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revokedAt === null)).toBe(true); // S1 gültig
    const hash = deviceHashOf(w.bernd.deviceCookie);
    expect(sessions.map((session) => session.deviceTokenHash)).toEqual([hash, hash]);
    expect(await subscriptionByEndpoint(w.endpoint)).toMatchObject({
      sessionId: w.s2Id,
      userId: w.bernd.user.id,
      disabledAt: null,
    });
    const devices = await ctx.app.inject({
      method: 'GET',
      url: '/staff/push/subscriptions',
      headers: { cookie: w.second.cookie },
    });
    expect((devices.json() as { devices: { currentSession: boolean }[] }).devices).toEqual([
      expect.objectContaining({ currentSession: true }),
    ]);
    // Hash/Klartext nie in Antworten (Login, eigene Sessions, Admin-Sessionliste).
    const ownSessions = await ctx.app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { cookie: w.second.cookie },
    });
    const adminSessions = await ctx.app.inject({
      method: 'GET',
      url: `/staff/users/${w.bernd.user.id}/sessions`,
      headers: { cookie: w.adminCookie },
    });
    expect(adminSessions.statusCode).toBe(200);
    for (const body of [JSON.stringify(w.second.body), ownSessions.body, adminSessions.body]) {
      expect(body).not.toContain(hash);
      expect(body).not.toMatch(/deviceToken|device_token/i);
    }
  });

  it('P12. S1 läuft danach per Inaktivität ab (auch vorgezeigt ⇒ widerrufen) ⇒ Push kommt weiter an, Status bleibt aktiv', async () => {
    const w = await reloginWorld('p12');
    await ctx.db
      .update(staffSessions)
      .set({ lastActivityAt: new Date(Date.now() - 31 * DAYS) })
      .where(eq(staffSessions.id, w.s1Id));
    await enqueueTestPush(w.bernd.user.id, 'final:p12:expired');
    await drainAll();
    expect(sentTo(w.endpoint, 'substitution_started')).toHaveLength(1);
    expect((await subscriptionByEndpoint(w.endpoint))!.disabledAt).toBeNull();
    // Altes Session-Cookie wird noch einmal vorgezeigt ⇒ S1 widerrufen; das Abo hängt an S2.
    const stale = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: w.bernd.cookie },
    });
    expect(stale.statusCode).toBe(401);
    const s1After = (await sessionsOf(w.bernd.user.id)).find((session) => session.id === w.s1Id);
    expect(s1After!.revokedAt).not.toBeNull();
    expect(await pushStatus(w.second.cookie, w.endpoint)).toBe(true);
    await enqueueTestPush(w.bernd.user.id, 'final:p12:revoked-old');
    await drainAll();
    expect(sentTo(w.endpoint, 'substitution_started')).toHaveLength(2);
  });

  it('P13. Logout von S2 ⇒ Abo technisch deaktiviert (session_revoked), kein Push; ein späterer Login desselben Geräts reaktiviert es NICHT', async () => {
    const w = await reloginWorld('p13');
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: w.second.cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(await subscriptionByEndpoint(w.endpoint)).toMatchObject({
      sessionId: w.s2Id,
      disabledReason: 'session_revoked',
    });
    await enqueueTestPush(w.bernd.user.id, 'final:p13');
    await drainAll();
    expect(ctx.push.forEndpoint(w.endpoint)).toHaveLength(0);
    expect((await deliveryByKey('final:p13'))!.lastErrorCode).toBe('NO_SUBSCRIPTIONS');
    // Erneuter Login (S3) vom selben Gerät: deaktivierte Abos bleiben deaktiviert.
    const third = await login(ctx.app, w.bernd.user.email, w.bernd.password, undefined, {
      deviceCookie: w.bernd.deviceCookie,
    });
    expect(third.statusCode).toBe(200);
    expect((await subscriptionByEndpoint(w.endpoint))!.disabledReason).toBe('session_revoked');
    expect(await pushStatus(third.cookie, w.endpoint)).toBe(false);
    expect((await subscriptionByEndpoint(w.endpoint))!.disabledAt).not.toBeNull();
  });

  it('P14. Anderer Mitarbeiter mit demselben Geräte-Cookie ⇒ kein Umbinden (keine Übertragung zwischen Personen); Bernd ohne/mit anderem Geräte-Cookie ⇒ kein Umbinden', async () => {
    const { admin } = await adminSession();
    const bernd = await employee(admin.id, 'Bernd');
    const endpoint = endpointFor('p14');
    await subscribe(bernd.cookie, endpoint);
    const [s1] = await sessionsOf(bernd.user.id);
    const carla = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Carla',
      lastName: 'Final',
      email: 'carla@final.example',
      password: 'carla-passwort-1234',
    });
    const carlaLogin = await login(ctx.app, carla.email, 'carla-passwort-1234', undefined, {
      deviceCookie: bernd.deviceCookie,
    });
    expect(carlaLogin.statusCode).toBe(200);
    const [carlaSession] = await sessionsOf(carla.id);
    expect(carlaSession!.deviceTokenHash).toBe(deviceHashOf(bernd.deviceCookie));
    expect(await subscriptionByEndpoint(endpoint)).toMatchObject({
      userId: bernd.user.id,
      sessionId: s1!.id,
      disabledAt: null,
    });
    // Bernd auf einem anderen Gerät (kein Cookie ⇒ neues Geräte-Cookie) ⇒ kein Umbinden.
    const otherDevice = await login(ctx.app, bernd.user.email, bernd.password);
    expect(otherDevice.statusCode).toBe(200);
    expect(otherDevice.deviceCookie).not.toBe(bernd.deviceCookie);
    expect((await subscriptionByEndpoint(endpoint))!.sessionId).toBe(s1!.id);
    // Push erreicht weiterhin nur Bernd.
    await enqueueTestPush(carla.id, 'final:p14:carla');
    await enqueueTestPush(bernd.user.id, 'final:p14:bernd');
    await drainAll();
    expect(ctx.push.forEndpoint(endpoint)).toHaveLength(1);
    expect((await deliveryByKey('final:p14:carla'))!.lastErrorCode).toBe('NO_SUBSCRIPTIONS');
  });

  it('P15. Session ohne Hash (vor dem Rollout) ⇒ Login bindet nicht um; die Statusroute bindet an die aktuelle Session (danach übersteht das Abo den Ablauf von S1, Logout deaktiviert)', async () => {
    const { admin } = await adminSession();
    const bernd = await employee(admin.id, 'Bernd');
    const endpoint = endpointFor('p15');
    await subscribe(bernd.cookie, endpoint);
    const [s1] = await sessionsOf(bernd.user.id);
    await ctx.db
      .update(staffSessions)
      .set({ deviceTokenHash: null })
      .where(eq(staffSessions.id, s1!.id));
    const second = await login(ctx.app, bernd.user.email, bernd.password, undefined, {
      deviceCookie: bernd.deviceCookie,
    });
    const s2 = (await sessionsOf(bernd.user.id)).find((session) => session.id !== s1!.id)!;
    expect(s2.deviceTokenHash).toBe(deviceHashOf(bernd.deviceCookie));
    expect((await subscriptionByEndpoint(endpoint))!.sessionId).toBe(s1!.id); // kein Umbinden
    // Statusroute aus S2: eigener Endpoint, gültige Session ⇒ aktiv + an S2 gebunden.
    expect(await pushStatus(second.cookie, endpoint)).toBe(true);
    expect((await subscriptionByEndpoint(endpoint))!.sessionId).toBe(s2.id);
    await ctx.db
      .update(staffSessions)
      .set({ lastActivityAt: new Date(Date.now() - 31 * DAYS) })
      .where(eq(staffSessions.id, s1!.id));
    await enqueueTestPush(bernd.user.id, 'final:p15');
    await drainAll();
    expect(ctx.push.forEndpoint(endpoint)).toHaveLength(1);
    await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: second.cookie },
    });
    expect((await subscriptionByEndpoint(endpoint))!.disabledReason).toBe('session_revoked');
  });

  it('P16. Statusroute: fremder User ⇒ false, nichts geändert; deaktiviert ⇒ false, keine Reaktivierung; Bindung an widerrufene/abgelaufene Session ⇒ false + technisch deaktiviert (auch der Login bindet von dort nicht um)', async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const bernd = await employee(admin.id, 'Bernd');
    const endpoint = endpointFor('p16');
    await subscribe(bernd.cookie, endpoint);
    const before = await subscriptionByEndpoint(endpoint);
    // (a) fremder User
    expect(await pushStatus(adminCookie, endpoint)).toBe(false);
    expect(await subscriptionByEndpoint(endpoint)).toEqual(before);
    expect(await pushStatus(adminCookie, endpointFor('p16-unbekannt'))).toBe(false);
    // (b) deaktiviert (z. B. 410) ⇒ bleibt deaktiviert
    await ctx.db
      .update(pushSubscriptions)
      .set({ disabledAt: new Date(), disabledReason: 'gone' })
      .where(eq(pushSubscriptions.endpoint, endpoint));
    expect(await pushStatus(bernd.cookie, endpoint)).toBe(false);
    expect((await subscriptionByEndpoint(endpoint))!.disabledReason).toBe('gone');

    // (c) Bindung an widerrufene Session ohne Listener-Lauf (Backstop-Fall).
    const carla = await employee(admin.id, 'Carla');
    const revokedEndpoint = endpointFor('p16-revoked');
    await subscribe(carla.cookie, revokedEndpoint);
    const [c1] = await sessionsOf(carla.user.id);
    await ctx.db
      .update(staffSessions)
      .set({ revokedAt: new Date(), revokedReason: 'test' })
      .where(eq(staffSessions.id, c1!.id));
    const c2 = await login(ctx.app, carla.user.email, carla.password, undefined, {
      deviceCookie: carla.deviceCookie,
    });
    expect((await subscriptionByEndpoint(revokedEndpoint))!.sessionId).toBe(c1!.id);
    expect(await pushStatus(c2.cookie, revokedEndpoint)).toBe(false);
    expect((await subscriptionByEndpoint(revokedEndpoint))!.disabledReason).toBe('session_revoked');

    // (d) Bindung an per Inaktivität abgelaufene Session.
    const dora = await employee(admin.id, 'Dora');
    const expiredEndpoint = endpointFor('p16-expired');
    await subscribe(dora.cookie, expiredEndpoint);
    const [d1] = await sessionsOf(dora.user.id);
    await ctx.db
      .update(staffSessions)
      .set({ lastActivityAt: new Date(Date.now() - 31 * DAYS) })
      .where(eq(staffSessions.id, d1!.id));
    const d2 = await login(ctx.app, dora.user.email, dora.password, undefined, {
      deviceCookie: dora.deviceCookie,
    });
    expect((await subscriptionByEndpoint(expiredEndpoint))!.sessionId).toBe(d1!.id);
    expect(await pushStatus(d2.cookie, expiredEndpoint)).toBe(false);
    expect((await subscriptionByEndpoint(expiredEndpoint))!.disabledReason).toBe('session_expired');
    // Erneute Registrierung (UI „aktivieren“) reaktiviert und bindet an die aktuelle Session.
    expect((await subscribe(d2.cookie, expiredEndpoint)).statusCode).toBe(200);
    expect(await pushStatus(d2.cookie, expiredEndpoint)).toBe(true);
  });

  it('P17. Fehler beim Umbinden bricht den Login nie; Log nur IDs + neutraler Code', async () => {
    const w = await reloginWorld('p17-setup');
    const spy = vi
      .spyOn(PushSubscriptionService.prototype, 'rebindSameDeviceSessions')
      .mockRejectedValue(new Error(`kaputt ${w.endpoint}`));
    logChunks.length = 0;
    const third = await login(ctx.app, w.bernd.user.email, w.bernd.password, undefined, {
      deviceCookie: w.bernd.deviceCookie,
    });
    expect(spy).toHaveBeenCalled();
    expect(third.statusCode).toBe(200);
    expect(third.cookie).not.toBe('');
    const log = logChunks.join('');
    expect(log).toContain('nicht an die neue Session gebunden');
    expect(log).not.toContain('kaputt');
    expect(log).not.toContain(w.endpoint);
    expect(log).not.toContain(deviceHashOf(w.bernd.deviceCookie));
    // Abo bleibt unverändert an S2 (kein Teilzustand).
    expect((await subscriptionByEndpoint(w.endpoint))!.sessionId).toBe(w.s2Id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RA10–RA12: Versandzeit-Prüfung (B2), RA13: 24-h-Grenze der Kurzfrist-Regel (B3)
// ═══════════════════════════════════════════════════════════════════════════

/** Rückgabe-Termin der Welt in `minutes` Minuten (1h-Fenster) planen. */
async function returnSoon(w: Awaited<ReturnType<typeof reassignmentWorld>>, minutes = 30) {
  const scheduling = schedulingServiceFor(ctx);
  const [ret] = await ctx.db
    .select()
    .from(appointments)
    .where(and(eq(appointments.bookingId, w.world.bookingId), eq(appointments.kind, 'return')));
  const startAt = new Date(Date.now() + minutes * MINUTES);
  await scheduling.reschedule(w.admin.id, ret!.id, {
    startAt,
    endAt: null,
    expectedVersion: ret!.version,
  });
  const effective = await ctx.auth.effectivePermissions(w.admin.id);
  return {
    id: ret!.id,
    startAt,
    assignTo: async (userId: string) => {
      const current = await scheduling.byId(ret!.id);
      return scheduling.assign(
        w.admin.id,
        ret!.id,
        { userId, expectedVersion: current.version },
        effective,
        new Date(startAt.getTime() - 20 * MINUTES),
      );
    },
    reschedule: async (minutesFromNow: number) => {
      const current = await scheduling.byId(ret!.id);
      return scheduling.reschedule(w.admin.id, ret!.id, {
        startAt: new Date(Date.now() + minutesFromNow * MINUTES),
        endAt: null,
        expectedVersion: current.version,
      });
    },
  };
}

const APPOINTMENT_1H = 'appointment_1h';

async function makeJobDue(deliveryId: string) {
  await ctx.db
    .update(integrationJobs)
    .set({ runAt: new Date(Date.now() - 1000) })
    .where(eq(integrationJobs.idempotencyKey, pushSendJobKey(deliveryId)));
}

describe('RA10–RA13: Zustellung nur, solange sie zum aktuellen Terminstand passt', () => {
  it('RA10. (Z1) Neuzuweisung Bernd → Carla NACH dem Claim-Commit, VOR push.send ⇒ Bernd 0 (skipped/SUPERSEDED, kein Gateway-Aufruf, Job ohne Retry beendet), Carla genau 1', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id, 0);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const [bernd] = await reassignedDeliveries();
    expect(bernd).toMatchObject({
      userId: w.bernd.user.id,
      status: 'pending',
      appointmentId: w.pickupId,
    });
    await w.assignTo(w.carla.user.id, 1); // Claim committed, Job noch nicht gelaufen
    await drainAll();
    expect(ctx.push.forEndpoint(w.endpoints.bernd)).toHaveLength(0);
    expect(await deliveryById(bernd!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_CODE,
      subscriptionsTargeted: 0,
      sentAt: null,
    });
    expect((await pushJobFor(bernd!.id))[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    expect(sentTo(w.endpoints.carla, REASSIGNED)).toHaveLength(1);
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(0);
  });

  it('RA10b. (Z1b) 1h-Push an Anna geclaimt, Neuzuweisung an Bernd vor push.send ⇒ Anna 0; Bernd bekommt beim nächsten Scan seinen eigenen 1h-Push', async () => {
    const w = await reassignmentWorld();
    const ret = await returnSoon(w);
    const now = new Date();
    expect(await scanner().scanAppointmentReminders(now)).toBe(1);
    const [anna] = await deliveriesOf(APPOINTMENT_1H);
    expect(anna).toMatchObject({ userId: w.anna.user.id, appointmentId: ret.id });
    await ret.assignTo(w.bernd.user.id);
    await drainAll();
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(0);
    expect(await deliveryById(anna!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_CODE,
    });
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1);
    await drainAll();
    expect(sentTo(w.endpoints.bernd, APPOINTMENT_1H)).toHaveLength(1);
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(0);
  });

  it('RA10c. (Z1c) Storno nach dem Claim (1h- und Kurzfrist-Push) ⇒ kein Push, beide skipped/SUPERSEDED', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id, 0);
    await returnSoon(w);
    expect(await scanner().scanDue(new Date())).toMatchObject({
      appointment1h: 1,
      reassignment: 1,
    });
    const scheduling = schedulingServiceFor(ctx);
    await ctx.db.transaction(async (tx) => {
      await scheduling.cancelForProcessWithin(tx, w.world.processId, new Date());
      await tx
        .update(processes)
        .set({ mainStatus: 'cancelled' })
        .where(eq(processes.id, w.world.processId));
    });
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(0);
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(0);
    const rows = [...(await reassignedDeliveries()), ...(await deliveriesOf(APPOINTMENT_1H))];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'skipped', lastErrorCode: PUSH_SUPERSEDED_CODE });
    }
  });

  it('RA10d. (Z1d) Erster Versuch transient, Neuzuweisung im Backoff ⇒ Retry ruft das Gateway nicht auf, Zustellung skipped/SUPERSEDED (Kurzfrist- und 1h-Push)', async () => {
    const w = await reassignmentWorld();
    ctx.push.setBehaviour(w.endpoints.bernd, 'transient');
    ctx.push.setBehaviour(w.endpoints.anna, 'transient');
    await w.assignTo(w.bernd.user.id, 0);
    const ret = await returnSoon(w);
    await scanner().scanDue(new Date());
    await drainAll();
    const [bernd] = await reassignedDeliveries();
    const [anna] = await deliveriesOf(APPOINTMENT_1H);
    for (const row of [bernd!, anna!]) {
      expect(await deliveryById(row.id)).toMatchObject({
        status: 'pending',
        lastErrorCode: 'HTTP_503',
      });
      expect((await pushJobFor(row.id))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    }
    expect(ctx.push.forEndpoint(w.endpoints.bernd)).toHaveLength(1);
    expect(ctx.push.forEndpoint(w.endpoints.anna)).toHaveLength(1);
    // Im Backoff: Neuzuweisungen; Geräte wären jetzt erreichbar.
    await w.assignTo(w.carla.user.id, 1);
    await ret.assignTo(w.carla.user.id);
    ctx.push.setBehaviour(w.endpoints.bernd, 'sent');
    ctx.push.setBehaviour(w.endpoints.anna, 'sent');
    await makeJobDue(bernd!.id);
    await makeJobDue(anna!.id);
    await drainAll();
    expect(ctx.push.forEndpoint(w.endpoints.bernd)).toHaveLength(1); // nur der transiente Versuch
    expect(ctx.push.forEndpoint(w.endpoints.anna)).toHaveLength(1);
    for (const row of [bernd!, anna!]) {
      expect(await deliveryById(row.id)).toMatchObject({
        status: 'skipped',
        lastErrorCode: PUSH_SUPERSEDED_CODE,
      });
      expect((await pushJobFor(row.id))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    }
  });

  it('RA10e. Prüfung vor JEDEM Gateway-Aufruf: Neuzuweisung während des Versands an Gerät 1 ⇒ Gerät 2 erhält nichts (Restfenster: der laufende Aufruf selbst)', async () => {
    const w = await reassignmentWorld();
    const secondEndpoint = endpointFor('ra10e-bernd-2');
    await subscribe(w.bernd.cookie, secondEndpoint);
    await w.assignTo(w.bernd.user.id, 0);
    class WithoutJob extends PushService {
      override async enqueueSendJob(): Promise<boolean> {
        return false; // push.send wird unten direkt mit dem Test-Gateway ausgeführt
      }
    }
    const withoutJob = scanner({ push: new WithoutJob(ctx.db, ctx.queue) });
    expect(await withoutJob.scanSameDayReassignments(new Date())).toBe(1);
    const [delivery] = await reassignedDeliveries();
    let switched = false;
    const racingGateway: PushGateway = {
      kind: 'fake',
      async send(target, payload) {
        const outcome = await ctx.push.send(target, payload);
        if (!switched) {
          switched = true;
          await w.assignTo(w.carla.user.id, 1); // committed während des laufenden Versands
        }
        return outcome;
      },
    };
    const { logger, lines } = capturingLogger();
    await createPushSendHandler({
      db: ctx.db,
      subscriptions: new PushSubscriptionService(ctx.db),
      gateway: racingGateway,
      logger,
    })({
      id: 'ra10e',
      type: PUSH_SEND_JOB_TYPE,
      payload: { deliveryId: delivery!.id },
      idempotencyKey: 'ra10e',
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'final',
    });
    const reached = [w.endpoints.bernd, secondEndpoint].map(
      (endpoint) => sentTo(endpoint, REASSIGNED).length,
    );
    expect(reached.sort()).toEqual([0, 1]); // genau der laufende Aufruf ging noch raus
    // Log: nur IDs/kind/Zähler/neutraler Code – nie Endpoint/Schlüssel.
    const superseded = lines.find((line) => line.includes('Zustellung überholt'));
    expect(JSON.parse(superseded!)).toMatchObject({
      deliveryId: delivery!.id,
      kind: REASSIGNED,
      code: PUSH_SUPERSEDED_CODE,
      targeted: 2,
      succeeded: 1,
    });
    for (const endpoint of [w.endpoints.bernd, secondEndpoint]) {
      expect(lines.join('\n')).not.toContain(endpoint);
    }
    expect(lines.join('\n')).not.toContain(KEYS.auth);
    expect(await deliveryById(delivery!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_CODE,
      subscriptionsTargeted: 2,
      subscriptionsSucceeded: 1,
    });
  });

  it('RA11. Positivkontrolle: unveränderter Stand ⇒ genau ein Kurzfrist- und ein 1h-Push (sent, mit appointmentId); Zustellungen ohne appointmentId (Altbestand) bleiben ungeprüft', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id, 0);
    const ret = await returnSoon(w);
    // Altbestand: Kurzfrist-Zustellung ohne appointmentId mit nicht (mehr) passendem Schlüssel.
    await new PushService(ctx.db, ctx.queue).enqueue({
      kind: 'assignment_reassigned',
      userId: w.carla.user.id,
      idempotencyKey: 'final:ra11:legacy',
      payload: buildPushPayload({
        kind: 'assignment_reassigned',
        processId: w.world.processId,
        processNumber: 'MR-2026-0001',
        appointmentKind: 'pickup',
      }),
    });
    expect(await scanner().scanDue(new Date())).toMatchObject({
      appointment1h: 1,
      reassignment: 1,
    });
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(1);
    expect(sentTo(w.endpoints.carla, REASSIGNED)).toHaveLength(1); // Altbestand unverändert
    const [reassigned] = (await reassignedDeliveries()).filter(
      (row) => row.userId === w.bernd.user.id,
    );
    const [oneHour] = await deliveriesOf(APPOINTMENT_1H);
    expect(reassigned).toMatchObject({ status: 'sent', appointmentId: w.pickupId });
    expect(oneHour).toMatchObject({ status: 'sent', appointmentId: ret.id });
    expect(await deliveryByKey('final:ra11:legacy')).toMatchObject({
      status: 'sent',
      appointmentId: null,
    });
  });

  it('RA12. Verschiebung nach dem 1h-Claim ⇒ alter 1h-Push skipped/SUPERSEDED; der nächste Scan sendet genau einen zur neuen Zeit', async () => {
    const w = await reassignmentWorld();
    const ret = await returnSoon(w, 30);
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1);
    const [old] = await deliveriesOf(APPOINTMENT_1H);
    await ret.reschedule(40);
    await drainAll();
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(0);
    expect(await deliveryById(old!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_CODE,
    });
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1);
    await drainAll();
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(1);
    const rows = await deliveriesOf(APPOINTMENT_1H);
    expect(rows.map((row) => row.status).sort()).toEqual(['sent', 'skipped']);
  });

  it('RA14. (Review 2, B1) 1h-Push überholt, Zuweisung danach zurückgenommen (Anna → Bernd → Anna) ⇒ überholte Zustellungen geben ihren Schlüssel frei, Anna erhält genau einen 1h-Push', async () => {
    const w = await reassignmentWorld();
    const ret = await returnSoon(w);
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1);
    const [first] = await deliveriesOf(APPOINTMENT_1H);
    await ret.assignTo(w.bernd.user.id);
    await drainAll();
    expect(await deliveryById(first!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_CODE,
      idempotencyKey: `${first!.idempotencyKey}:superseded:${first!.id}`,
    });
    const markers = await ctx.db
      .select()
      .from(appointmentReminders)
      .where(eq(appointmentReminders.appointmentId, ret.id));
    expect(markers.every((marker) => marker.pushDeliveryId !== first!.id)).toBe(true);
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1); // Bernd
    await ret.assignTo(w.anna.user.id);
    await drainAll();
    expect(sentTo(w.endpoints.bernd, APPOINTMENT_1H)).toHaveLength(0);
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1); // wieder Anna
    await drainAll();
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(1);
    expect(sentTo(w.endpoints.bernd, APPOINTMENT_1H)).toHaveLength(0);
    const rows = await deliveriesOf(APPOINTMENT_1H);
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(1);
    expect(rows.find((row) => row.status === 'sent')!.idempotencyKey).toBe(first!.idempotencyKey);
    // Erneuter Scan: erledigt, kein zweiter Push.
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(0);
    await drainAll();
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(1);
  });

  it('RA15. (Review 2, B1) 1h-Push überholt durch Verschiebung, danach zurück auf die ursprüngliche Zeit ⇒ genau ein 1h-Push zur ursprünglichen Zeit', async () => {
    const w = await reassignmentWorld();
    const ret = await returnSoon(w, 30);
    const scheduling = schedulingServiceFor(ctx);
    const rescheduleTo = async (startAt: Date) => {
      const current = await scheduling.byId(ret.id);
      return scheduling.reschedule(w.admin.id, ret.id, {
        startAt,
        endAt: null,
        expectedVersion: current.version,
      });
    };
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1);
    await rescheduleTo(new Date(ret.startAt.getTime() + 10 * MINUTES));
    await drainAll();
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(0);
    await rescheduleTo(ret.startAt);
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(1);
    await drainAll();
    expect(sentTo(w.endpoints.anna, APPOINTMENT_1H)).toHaveLength(1);
    expect(await scanner().scanAppointmentReminders(new Date())).toBe(0);
  });

  it('RA13. (B3) Kurzfrist-Regel nur für Neuzuweisungen der letzten 24 h: 10 Tage / 24 h + 1 min alt ⇒ weder Push noch Claim; frische Neuzuweisung am heutigen Termin ⇒ genau ein Push', async () => {
    const w = await reassignmentWorld();
    await w.assignTo(w.bernd.user.id, 0);
    const now = new Date();
    // Phase 12 Finalisierung 2 (Regel C): Push nur, wenn start_at am selben Berliner
    // Kalendertag wie requestedAt liegt; deshalb wandert start_at mit (gleicher Zeitpunkt),
    // geprüft wird hier die 24-h-Grenze. Review Runde 3 (B2): ein Claim NACH dem
    // Durchführungstag entsteht nie – die Positivkontrolle nutzt daher eine frische
    // Neuzuweisung am heutigen Termin (der Tagesfall steht in KR14).
    const setRequestedAt = (at: Date, startAt = at) =>
      ctx.db
        .update(appointments)
        .set({ acknowledgementRequestedAt: at, startAt })
        .where(eq(appointments.id, w.pickupId));
    for (const age of [10 * DAYS, DAYS + MINUTES]) {
      await setRequestedAt(new Date(now.getTime() - age));
      expect(await scanner().scanSameDayReassignments(now)).toBe(0);
      expect(await reassignedDeliveries()).toHaveLength(0);
      expect((await w.current()).assignmentNotifiedAt).toBeNull(); // nicht geclaimt
    }
    const requestedAt = new Date(now.getTime() - 1000);
    await setRequestedAt(requestedAt, now);
    expect(await scanner().scanSameDayReassignments(now)).toBe(1);
    const [row] = await reassignedDeliveries();
    expect(row!.idempotencyKey).toBe(
      pushKeys.reassignment(w.pickupId, requestedAt, w.bernd.user.id),
    );
    await drainAll();
    expect(sentTo(w.endpoints.bernd, REASSIGNED)).toHaveLength(1);
  });
});
