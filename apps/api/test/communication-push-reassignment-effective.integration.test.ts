/**
 * Phase 12 Finalisierung 2 (Auftrag 2026-10-22, Punkte 2 + 3) – Pflichttests
 * „KR“ (= Auftrag R1–R12; umbenannt, um Verwechslung mit den Retention-Tests
 * R1–R31 zu vermeiden): Kurzfrist-Push bei Neuzuweisung am Durchführungstag
 *  - an die EFFEKTIVE Zuständigkeit (Vertretung), Bestätigung bleibt beim
 *    direkt Zugewiesenen (Phase 4),
 *  - nur, solange start_at am selben Berliner Kalendertag wie requestedAt liegt
 *    (Claim UND Versandzeit), ohne Wiederbelebung geschlossener Versionen,
 *  - Vertretungswechsel zwischen Claim und Versand ⇒ alte Zustellung
 *    `SUPERSEDED_RECIPIENT`, neue Person genau einmal.
 * Testwelt/Helfer aus communication-push-final übernommen (dort nicht exportiert).
 */
import { Writable } from 'node:stream';
import { appointments, integrationJobs, processes, pushDeliveries } from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq } from 'drizzle-orm';
import { berlinDateOf } from '@mietroyal/domain';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushService, pushSendJobKey } from '../src/communication/push/push-service.ts';
import {
  pushKeys,
  PushRuleScanner,
  type PushRuleScannerDeps,
} from '../src/communication/push/rules.ts';
import {
  PUSH_SUPERSEDED_CODE,
  PUSH_SUPERSEDED_RECIPIENT_CODE,
} from '../src/communication/push/supersede.ts';
import { PUSH_SEND_JOB_TYPE } from '../src/communication/types.ts';
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
  substitutionServiceFor,
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
const REASSIGNED = 'assignment_reassigned';

/** Durchführung morgen 10:00 UTC (11:00/12:00 Berlin); Neuzuweisung 06:00 UTC – gleicher Berliner Tag. */
function tomorrowAt(hourUtc: number): Date {
  const day = new Date(Date.now() + DAYS);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc));
}
const START_AT = tomorrowAt(10);
const ASSIGN_AT = tomorrowAt(6);
const NEXT_DAY = new Date(START_AT.getTime() + DAYS);

function endpointFor(label: string): string {
  return `https://push.example.test/send/kr-${label}-${'e'.repeat(40)}`;
}

async function employee(adminId: string, name: string) {
  const password = `${name.toLowerCase()}-passwort-1234`;
  const user = await createEmployeeWithPassword(ctx, adminId, {
    firstName: name,
    lastName: 'Kurzfrist',
    email: `${name.toLowerCase()}@kr.example`,
    password,
  });
  const session = await login(ctx.app, user.email, password);
  return { user, cookie: session.cookie };
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

async function reassignedDeliveries() {
  return (await ctx.db.select().from(pushDeliveries)).filter((row) => row.kind === REASSIGNED);
}

async function deliveryById(id: string) {
  const rows = await ctx.db.select().from(pushDeliveries).where(eq(pushDeliveries.id, id));
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

function capturingLogger(): { logger: JobRunnerLogger; lines: string[] } {
  const lines: string[] = [];
  const write = (level: string) => (context: Record<string, unknown>, message: string) => {
    lines.push(JSON.stringify({ level, message, ...context }));
  };
  return { logger: { info: write('info'), warn: write('warn'), error: write('error') }, lines };
}

/**
 * Testwelt: Abholung morgen START_AT, ursprünglich Dora zugewiesen; Anna, Bernd,
 * Carla, Dora mit je einem Push-Gerät. `assignTo` = Neuzuweisung am
 * Durchführungstag (Phase-4-Service), `substitute`/`endSubstitution` = echte
 * Vertretungsverwaltung (SubstitutionService).
 */
async function world() {
  const admin = await bootstrapAdmin(ctx);
  const adminSession = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const anna = await employee(admin.id, 'Anna');
  const bernd = await employee(admin.id, 'Bernd');
  const carla = await employee(admin.id, 'Carla');
  const dora = await employee(admin.id, 'Dora');
  const booking = await createAcceptedBooking(ctx, admin.id, { assignProcessTo: dora.user.id });
  const scheduling = schedulingServiceFor(ctx);
  const substitutions = substitutionServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(booking.bookingId);
  const [pickup] = await ctx.db
    .select()
    .from(appointments)
    .where(and(eq(appointments.bookingId, booking.bookingId), eq(appointments.kind, 'pickup')));
  await scheduling.reschedule(admin.id, pickup!.id, {
    startAt: START_AT,
    endAt: null,
    expectedVersion: pickup!.version,
  });
  expect((await scheduling.byId(pickup!.id)).assignedUserId).toBe(dora.user.id);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  const endpoints = {
    anna: endpointFor('anna'),
    bernd: endpointFor('bernd'),
    carla: endpointFor('carla'),
    dora: endpointFor('dora'),
  };
  for (const [person, endpoint] of [
    [anna, endpoints.anna],
    [bernd, endpoints.bernd],
    [carla, endpoints.carla],
    [dora, endpoints.dora],
  ] as const) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions',
      headers: { cookie: person.cookie },
      payload: { endpoint, keys: KEYS, userAgentLabel: 'KR-Gerät' },
    });
    expect(response.statusCode).toBe(200);
  }
  const pickupId = pickup!.id;
  const current = () => scheduling.byId(pickupId);
  return {
    admin,
    adminCookie: adminSession.cookie,
    anna,
    bernd,
    carla,
    dora,
    booking,
    pickupId,
    endpoints,
    current,
    scheduling,
    /** Neuzuweisung am Durchführungstag (`offsetMinutes` nach ASSIGN_AT). */
    assignTo: async (userId: string, offsetMinutes = 0) =>
      scheduling.assign(
        admin.id,
        pickupId,
        { userId, expectedVersion: (await current()).version },
        effective,
        new Date(ASSIGN_AT.getTime() + offsetMinutes * MINUTES),
      ),
    reschedule: async (startAt: Date) =>
      scheduling.reschedule(admin.id, pickupId, {
        startAt,
        endAt: null,
        expectedVersion: (await current()).version,
      }),
    /** Vertretung original → substitute, aktiv ab jetzt (bzw. sofort) bis nach START_AT. */
    substitute: async (originalUserId: string, substituteUserId: string) =>
      substitutions.create(admin.id, {
        originalUserId,
        substituteUserId,
        startsAt: new Date(Date.now() - HOURS),
        endsAt: new Date(START_AT.getTime() + 2 * HOURS),
      }),
    /** Vorzeitiges Ende ⇒ sofort wirksam; eine Folgevertretung beginnt danach. */
    endSubstitution: async (substitutionId: string) =>
      substitutions.endEarly(substitutionId, new Date()),
    substituteFromNow: async (originalUserId: string, substituteUserId: string) =>
      substitutions.create(admin.id, {
        originalUserId,
        substituteUserId,
        startsAt: new Date(Date.now() + 1000),
        endsAt: new Date(START_AT.getTime() + 2 * HOURS),
      }),
    cancel: async () =>
      ctx.db.transaction(async (tx) => {
        await scheduling.cancelForProcessWithin(tx, booking.processId, new Date());
        await tx
          .update(processes)
          .set({ mainStatus: 'cancelled' })
          .where(eq(processes.id, booking.processId));
      }),
  };
}

type World = Awaited<ReturnType<typeof world>>;

function sentTo(endpoint: string) {
  return ctx.push.forEndpoint(endpoint).filter((record) => record.payload.kind === REASSIGNED);
}

function sentCounts(w: World) {
  return {
    anna: sentTo(w.endpoints.anna).length,
    bernd: sentTo(w.endpoints.bernd).length,
    carla: sentTo(w.endpoints.carla).length,
    dora: sentTo(w.endpoints.dora).length,
  };
}

/** Neuzuweisung Dora → Anna am Durchführungstag; Anna durch Bernd vertreten. */
async function annaSubstitutedByBernd() {
  const w = await world();
  const substitution = await w.substitute(w.anna.user.id, w.bernd.user.id);
  const assigned = await w.assignTo(w.anna.user.id);
  expect(assigned.acknowledgementRequestedFor).toBe(w.anna.user.id);
  expect(assigned.acknowledgementRequestedAt).toEqual(ASSIGN_AT);
  return { w, substitution, requestedAt: assigned.acknowledgementRequestedAt! };
}

/** KR6/KR7: Claim an Bernd, danach Vertretungswechsel Bernd → Carla vor push.send. */
async function claimThenSwitchToCarla() {
  const { w, substitution, requestedAt } = await annaSubstitutedByBernd();
  expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
  const [bernd] = await reassignedDeliveries();
  expect(bernd).toMatchObject({ userId: w.bernd.user.id, status: 'pending' });
  await w.endSubstitution(substitution.id);
  await w.substituteFromNow(w.anna.user.id, w.carla.user.id);
  await drainAll();
  return { w, requestedAt, berndDelivery: bernd! };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('KR1–KR4: Empfänger = effektive Zuständigkeit, Bestätigung beim direkt Zugewiesenen', () => {
  it('KR1. Heutige Neuzuweisung ohne Vertretung ⇒ die direkt zugewiesene Person bekommt genau einen Push (K(Anna)); Folgescans no-op', async () => {
    const w = await world();
    const assigned = await w.assignTo(w.anna.user.id);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const rows = await reassignedDeliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: w.anna.user.id,
      appointmentId: w.pickupId,
      idempotencyKey: pushKeys.reassignment(
        w.pickupId,
        assigned.acknowledgementRequestedAt!,
        w.anna.user.id,
      ),
    });
    expect((await w.current()).assignmentNotifiedAt).not.toBeNull();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 1, bernd: 0, carla: 0, dora: 0 });
    expect((await reassignedDeliveries())[0]!.status).toBe('sent');
  });

  it('KR2. Mit aktiver Vertretung (Anna durch Bernd vertreten) ⇒ der Vertreter Bernd bekommt den Push (K(Bernd) mit Annas requestedAt)', async () => {
    const { w, requestedAt } = await annaSubstitutedByBernd();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const rows = await reassignedDeliveries();
    expect(rows.map((row) => row.userId)).toEqual([w.bernd.user.id]);
    expect(rows[0]!.idempotencyKey).toBe(
      pushKeys.reassignment(w.pickupId, requestedAt, w.bernd.user.id),
    );
    expect(await pushJobFor(rows[0]!.id)).toHaveLength(1);
    await drainAll();
    expect(sentTo(w.endpoints.bernd)).toHaveLength(1);
    expect((await deliveryById(rows[0]!.id))!.status).toBe('sent');
  });

  it('KR3. Die direkt zugewiesene Person (Anna) bekommt in KR2 KEINEN Kurzfrist-Push – auch nicht nach weiteren Scans', async () => {
    const { w } = await annaSubstitutedByBernd();
    await scanner().scanSameDayReassignments(new Date());
    await drainAll();
    for (let i = 0; i < 3; i += 1) {
      expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
      expect((await scanner().scanDue(new Date())).reassignment).toBe(0);
    }
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 1, carla: 0, dora: 0 });
    expect(
      (await reassignedDeliveries()).filter((row) => row.userId === w.anna.user.id),
    ).toHaveLength(0);
  });

  it('KR4. Acknowledge bleibt beim direkt Zugewiesenen: Vertreter Bernd darf nicht bestätigen (Service FORBIDDEN, Route 403), Anna schon', async () => {
    const { w } = await annaSubstitutedByBernd();
    await scanner().scanSameDayReassignments(new Date());
    await drainAll();
    expect((await w.current()).acknowledgementRequestedFor).toBe(w.anna.user.id);
    await expect(w.scheduling.acknowledge(w.bernd.user.id, w.pickupId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Route: beide mit `calendar.view` (Voraussetzung der Route); Bernd sieht den Termin
    // als effektiver Zuständiger, darf ihn aber nicht bestätigen (Identitätsbindung).
    const roleId = await ctx.admin.createRole(w.admin.id, {
      name: 'KR4 Kalender',
      permissionKeys: ['calendar.view'],
    });
    const cookies: Record<string, string> = {};
    for (const [name, person] of [
      ['anna', w.anna],
      ['bernd', w.bernd],
    ] as const) {
      await ctx.admin.setUserRoles(w.admin.id, person.user.id, [roleId]);
      cookies[name] = (await login(ctx.app, person.user.email, `${name}-passwort-1234`)).cookie;
    }
    const byBernd = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${w.pickupId}/acknowledge`,
      headers: { cookie: cookies.bernd! },
    });
    expect(byBernd.statusCode).toBe(403);
    expect((await w.current()).acknowledgedAt).toBeNull();
    const byAnna = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${w.pickupId}/acknowledge`,
      headers: { cookie: cookies.anna! },
    });
    expect(byAnna.statusCode).toBe(200);
    const acknowledged = await w.current();
    expect(acknowledged.acknowledgedBy).toBe(w.anna.user.id);
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    // Bestätigung ändert nichts am Push (kein weiterer Push, keine Wiederholung).
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
  });
});

describe('KR5–KR7: Vertretungswechsel vor/nach dem Claim', () => {
  it('KR5. Vertretung wechselt (Bernd → Carla) GENAU zwischen Lesen und Claim ⇒ nur der neue effektive Empfänger Carla (Vertretungen in der Claim-Transaktion geladen)', async () => {
    const { w, substitution } = await annaSubstitutedByBernd();
    let switched = false;
    const racing = scanner({
      onCandidateRead: async (candidate) => {
        if (candidate.rule === 'assignment_reassigned' && !switched) {
          switched = true;
          await w.endSubstitution(substitution.id);
          await w.substituteFromNow(w.anna.user.id, w.carla.user.id);
        }
      },
    });
    expect(await racing.scanSameDayReassignments(new Date())).toBe(1);
    expect(switched).toBe(true);
    expect((await reassignedDeliveries()).map((row) => row.userId)).toEqual([w.carla.user.id]);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 1, dora: 0 });
  });

  it('KR6. Vertretung wechselt NACH dem Claim, VOR push.send ⇒ Bernds Zustellung skipped/SUPERSEDED_RECIPIENT, kein Gateway-Aufruf, Schlüssel freigegeben, Job ohne Retry beendet', async () => {
    const { w, berndDelivery } = await claimThenSwitchToCarla();
    expect(ctx.push.forEndpoint(w.endpoints.bernd)).toHaveLength(0);
    expect(await deliveryById(berndDelivery.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_RECIPIENT_CODE,
      subscriptionsTargeted: 0,
      sentAt: null,
      idempotencyKey: `${berndDelivery.idempotencyKey}:superseded:${berndDelivery.id}`,
    });
    expect((await pushJobFor(berndDelivery.id))[0]).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    // Nicht schließend: die Version bleibt offen für die neue Person.
    expect((await w.current()).acknowledgementRequestedFor).toBe(w.anna.user.id);
  });

  it('KR7. Neuer effektiver Empfänger (Carla) bekommt danach GENAU einen Push – auch nach weiteren Scans (assignment_notified_at verhindert das nicht)', async () => {
    const { w, requestedAt } = await claimThenSwitchToCarla();
    expect((await w.current()).assignmentNotifiedAt).not.toBeNull();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const carla = (await reassignedDeliveries()).find((row) => row.userId === w.carla.user.id);
    expect(carla!.idempotencyKey).toBe(
      pushKeys.reassignment(w.pickupId, requestedAt, w.carla.user.id),
    );
    for (let i = 0; i < 3; i += 1) {
      expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
      expect((await scanner().scanDue(new Date())).reassignment).toBe(0);
    }
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 1, dora: 0 });
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 1, dora: 0 });
    expect(await reassignedDeliveries()).toHaveLength(2);
  });

  it('KR7b. Hin-und-her Vertretung Anna → Bernd → Anna (→ Bernd): bereits GESENDETE Zustellungen werden nie erneut gesendet; je Person höchstens ein Push', async () => {
    const w = await world();
    await w.assignTo(w.anna.user.id);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 1, bernd: 0, carla: 0, dora: 0 });

    const first = await w.substitute(w.anna.user.id, w.bernd.user.id);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1); // Bernd
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 1, bernd: 1, carla: 0, dora: 0 });

    await w.endSubstitution(first.id); // zurück an Anna – K(Anna) bereits gesendet
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    await w.substituteFromNow(w.anna.user.id, w.bernd.user.id); // wieder Bernd
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect((await scanner().scanDue(new Date())).reassignment).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 1, bernd: 1, carla: 0, dora: 0 });
    const rows = await reassignedDeliveries();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'sent')).toBe(true);
  });

  it('KR7c. Hin-und-her VOR dem Versand (Anna → Bernd → Anna): überholte, nie gesendete Zustellungen geben ihren Schlüssel frei; Anna erhält am Ende genau einen Push, Bernd keinen', async () => {
    const w = await world();
    await w.assignTo(w.anna.user.id);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1); // K(Anna) pending
    const sub = await w.substitute(w.anna.user.id, w.bernd.user.id);
    await drainAll(); // Anna-Zustellung ⇒ SUPERSEDED_RECIPIENT, Schlüssel frei
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1); // K(Bernd) pending
    await w.endSubstitution(sub.id);
    await drainAll(); // Bernd-Zustellung ⇒ SUPERSEDED_RECIPIENT
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1); // neue K(Anna)
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 1, bernd: 0, carla: 0, dora: 0 });
    const rows = await reassignedDeliveries();
    expect(rows.map((row) => `${row.status}:${row.lastErrorCode ?? '-'}`).sort()).toEqual(
      [
        `skipped:${PUSH_SUPERSEDED_RECIPIENT_CODE}`,
        `skipped:${PUSH_SUPERSEDED_RECIPIENT_CODE}`,
        'sent:-',
      ].sort(),
    );
  });
});

describe('KR8–KR9: nur bei Durchführung am selben Berliner Kalendertag', () => {
  it('KR13. (Review Runde 3, B1) Retry nach Teilerfolg + Vertretungswechsel: der bereits erreichte Empfänger behält seinen Schlüssel – nach Ende der Vertretung KEIN zweiter Push an dieselbe Person', async () => {
    const w = await world();
    // Anna hat zwei Geräte; Gerät 2 antwortet vorübergehend mit Fehler.
    const annaSecond = endpointFor('anna-2');
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions',
      headers: { cookie: w.anna.cookie },
      payload: { endpoint: annaSecond, keys: KEYS, userAgentLabel: 'KR-Gerät 2' },
    });
    expect(registered.statusCode).toBe(200);
    ctx.push.setBehaviour(annaSecond, 'transient');
    await w.assignTo(w.anna.user.id);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const [anna] = await reassignedDeliveries();
    await drainAll();
    expect(sentTo(w.endpoints.anna)).toHaveLength(1);
    expect(await deliveryById(anna!.id)).toMatchObject({
      status: 'pending',
      subscriptionsSucceeded: 1,
    });
    // Im Retry-Backoff beginnt eine Vertretung Anna → Bernd.
    const substitution = await w.substitute(w.anna.user.id, w.bernd.user.id);
    await ctx.db
      .update(integrationJobs)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(integrationJobs.idempotencyKey, pushSendJobKey(anna!.id)));
    await drainAll();
    expect(await deliveryById(anna!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_RECIPIENT_CODE,
      subscriptionsSucceeded: 1, // Erfolg des ersten Versuchs bleibt erhalten
      idempotencyKey: anna!.idempotencyKey, // NICHT freigegeben – Anna wurde erreicht
    });
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1); // Bernd
    await drainAll();
    expect(sentCounts(w)).toMatchObject({ anna: 1, bernd: 1 });
    // Vertretung endet ⇒ Anna wieder zuständig – sie hat den Push schon ⇒ kein zweiter.
    await w.endSubstitution(substitution.id);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toMatchObject({ anna: 1, bernd: 1 });
  });

  it('KR14. (Review Runde 3, B2) Kein „Kurzfrist“-Push NACH dem Durchführungstag: endet die Vertretung und ist am Folgetag (< 24 h nach der Neuzuweisung) wieder die Originalperson zuständig, entsteht kein neuer Anspruch', async () => {
    const { w, substitution } = await annaSubstitutedByBernd();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    expect(sentCounts(w)).toMatchObject({ anna: 0, bernd: 1 });
    await w.endSubstitution(substitution.id);
    // Folgetag 05:00 UTC (anderer Berliner Kalendertag als der Termin), < 24 h nach requestedAt.
    const nextMorning = new Date(ASSIGN_AT.getTime() + 23 * HOURS);
    expect(berlinDateOf(nextMorning)).not.toBe(berlinDateOf(START_AT));
    expect(await scanner().scanSameDayReassignments(nextMorning)).toBe(0);
    expect((await reassignedDeliveries()).map((row) => row.userId)).toEqual([w.bernd.user.id]);
    await drainAll();
    expect(sentCounts(w)).toMatchObject({ anna: 0, bernd: 1 });
    // Kontrolle: am Durchführungstag selbst erreicht der Wechsel die Originalperson.
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    expect(sentCounts(w)).toMatchObject({ anna: 1, bernd: 1 });
  });

  it('KR8. Nach der Neuzuweisung (vor dem Claim) auf den nächsten Tag verschoben ⇒ kein Push, Version erledigt (ack-Info bleibt); zurück auf heute ⇒ weiterhin kein Push', async () => {
    const w = await world();
    await w.assignTo(w.anna.user.id);
    await w.reschedule(NEXT_DAY);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect(await reassignedDeliveries()).toHaveLength(0);
    const handled = await w.current();
    expect(handled.assignmentNotifiedAt).not.toBeNull(); // Anspruch erledigt (no-op)
    expect(handled.acknowledgementRequestedAt).toEqual(ASSIGN_AT); // Phase-4-Info bleibt
    expect(handled.acknowledgementRequestedFor).toBe(w.anna.user.id);

    await w.reschedule(START_AT); // zurück auf den Tag der Neuzuweisung
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect((await scanner().scanDue(new Date())).reassignment).toBe(0);
    await drainAll();
    expect(await reassignedDeliveries()).toHaveLength(0);
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 0, dora: 0 });
  });

  it('KR9. Nach dem Claim auf den nächsten Tag verschoben ⇒ skipped/SUPERSEDED (Schlüssel bleibt belegt); zurück auf heute ⇒ kein Push (keine Wiederbelebung)', async () => {
    const w = await world();
    await w.assignTo(w.anna.user.id);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const [claimed] = await reassignedDeliveries();
    await w.reschedule(NEXT_DAY);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 0, dora: 0 });
    expect(await deliveryById(claimed!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_CODE,
      idempotencyKey: claimed!.idempotencyKey, // NICHT freigegeben (Version geschlossen)
    });

    await w.reschedule(START_AT);
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect((await scanner().scanDue(new Date())).reassignment).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 0, dora: 0 });
    expect((await reassignedDeliveries()).map((row) => row.id)).toEqual([claimed!.id]);
  });
});

describe('KR10–KR12: Parallelität, Storno, Datenminimierung', () => {
  it('KR10. Parallele Scanner (Promise.all über scanDue) ⇒ genau eine Zustellung/ein Push an den Vertreter; nach Vertretungswechsel parallel genau eine weitere', async () => {
    const { w, substitution } = await annaSubstitutedByBernd();
    const now = new Date();
    const first = await Promise.all(Array.from({ length: 5 }, () => scanner().scanDue(now)));
    expect(first.reduce((sum, summary) => sum + summary.reassignment, 0)).toBe(1);
    const rows = await reassignedDeliveries();
    expect(rows.map((row) => row.userId)).toEqual([w.bernd.user.id]);
    expect(await pushJobFor(rows[0]!.id)).toHaveLength(1);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 1, carla: 0, dora: 0 });

    await w.endSubstitution(substitution.id);
    await w.substituteFromNow(w.anna.user.id, w.carla.user.id);
    const second = await Promise.all(
      Array.from({ length: 5 }, () => scanner().scanSameDayReassignments(new Date())),
    );
    expect(second.reduce((sum, count) => sum + count, 0)).toBe(1);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 1, carla: 1, dora: 0 });
    const all = await reassignedDeliveries();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((row) => row.idempotencyKey)).size).toBe(2);
  });

  it('KR11. Storno VOR dem Claim ⇒ kein Push, keine Zustellung (Termin storniert ⇒ kein Kandidat)', async () => {
    const { w } = await annaSubstitutedByBernd();
    await w.cancel();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect((await scanner().scanDue(new Date())).reassignment).toBe(0);
    await drainAll();
    expect(await reassignedDeliveries()).toHaveLength(0);
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 0, dora: 0 });
  });

  it('KR11b. Storno NACH dem Claim ⇒ Zustellung skipped/SUPERSEDED (schließend), kein Push; Vorgang storniert bei noch offenem Termin ⇒ Claim ohne Push', async () => {
    const { w } = await annaSubstitutedByBernd();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(1);
    const [claimed] = await reassignedDeliveries();
    await w.cancel();
    await drainAll();
    expect(await deliveryById(claimed!.id)).toMatchObject({
      status: 'skipped',
      lastErrorCode: PUSH_SUPERSEDED_CODE,
      idempotencyKey: claimed!.idempotencyKey,
    });
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    await drainAll();
    expect(sentCounts(w)).toEqual({ anna: 0, bernd: 0, carla: 0, dora: 0 });

    // Vorgang storniert, Termin (noch) geplant ⇒ Claim erledigt die Version ohne Push.
    await ctx.pool.query('TRUNCATE push_deliveries CASCADE');
    await ctx.db
      .update(appointments)
      .set({ status: 'scheduled', assignmentNotifiedAt: null })
      .where(eq(appointments.id, w.pickupId));
    expect(
      await scanner().claimReassignment(
        {
          appointmentId: w.pickupId,
          requestedAt: ASSIGN_AT,
          requestedFor: w.anna.user.id,
        },
        new Date(),
      ),
    ).toEqual({ deliveryId: null, skipped: 'process_cancelled' });
    expect((await w.current()).assignmentNotifiedAt).not.toBeNull();
    expect(await scanner().scanSameDayReassignments(new Date())).toBe(0);
    expect(await reassignedDeliveries()).toHaveLength(0);
  });

  it('KR12. Datenminimierung: Nutzlast nur {kind,title,body,url,tag}; Schlüssel nur IDs/Zeitpunkt (Termin, requestedAt, effektiver Empfänger); keine Kundendaten in Nutzlast, Logs, Fehlercodes', async () => {
    const { w, substitution, requestedAt } = await annaSubstitutedByBernd();
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
      kind: REASSIGNED,
      title: 'Kurzfristig zugewiesen',
      url: `/vorgaenge/${w.booking.processId}/termine`,
    });
    expect((row!.payload as { body: string }).body).toMatch(
      /^Abholung MR-\d{4}-\d{4,} – in Miet-Royal prüfen$/,
    );
    expect(row!.idempotencyKey).toBe(
      `push:assignment_reassigned:${w.pickupId}:${requestedAt.toISOString()}:${w.bernd.user.id}`,
    );
    // Vertretungswechsel ⇒ überholte Zustellung: Fehlercode neutral, Log nur IDs.
    await w.endSubstitution(substitution.id);
    await drainAll();
    expect((await deliveryById(row!.id))!.lastErrorCode).toBe(PUSH_SUPERSEDED_RECIPIENT_CODE);
    expect(await scanner({ logger }).scanSameDayReassignments(new Date())).toBe(1);
    await drainAll();
    const [sent] = sentTo(w.endpoints.anna);
    const serialized = [
      JSON.stringify(await reassignedDeliveries()),
      JSON.stringify(sent!.payload),
      lines.join('\n'),
      logChunks.join(''),
    ].join('\n');
    for (const forbidden of ['Klara', 'Kommerz', '9998877', 'klara.kommerz', 'Lieferweg', '€']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    const logs = `${lines.join('\n')}\n${logChunks.join('')}`;
    for (const endpoint of Object.values(w.endpoints)) expect(logs).not.toContain(endpoint);
    expect(logs).not.toContain(KEYS.auth);
    expect(logs).not.toContain(KEYS.p256dh);
  });
});
