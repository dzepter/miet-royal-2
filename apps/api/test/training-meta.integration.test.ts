import { randomUUID } from 'node:crypto';
import {
  staffSecurityEvents,
  trainingAssignments,
  trainingAttemptEvents,
  trainingAttempts,
  trainingDefinitions,
  trainingPathItems,
  trainingPaths,
} from '@mietroyal/database';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_MESSAGES } from '../src/demo/types.ts';
import { TRAINING_ERROR_CODES } from '../src/training/errors.ts';
import { DEMO_RESET_INTERRUPTION_CODE } from '../src/training/training-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createCommerceWorld } from './commerce-helpers.ts';
import { handoverServicesFor, scheduledBooking } from './handover-helpers.ts';
import {
  adminSession,
  apiFor,
  attemptRow,
  attemptsOfUser,
  catalogVariant,
  checkAttempt,
  createTrainingDemoContext,
  eventsOf,
  resetTrainingWorld,
  startAttempt,
  startedAttemptId,
  syncCatalog,
  trainee,
  trainingMe,
} from './training-helpers.ts';

/**
 * Phase 14 (Training, Order §105 – Pflichttests 69–89, Design §4.7):
 * Trainings-Metaebene – Katalog-Sync (stabile Keys, Version, Reihenfolge),
 * Zuweisungen, IDOR, Versuche (idempotent, je Mitarbeiter), Recorder-Grenzen
 * (fremder Akteur, außerhalb demo, Rollback), Prüfen, automatisches Bestehen,
 * Duplikate, Update-/Reset-Stabilität, inaktive Übung, keine Businessdaten.
 * Läuft gegen eine eigene Test-DB (TEST_DATABASE_URL, Agent TRAINING-CORE).
 */

const HANDOVER_PERMISSIONS = ['handover.view', 'handover.perform', 'process.view_all'] as const;

let demo: TestContext;
let dev: TestContext;

beforeAll(async () => {
  demo = await createTrainingDemoContext();
  dev = await createTestContext();
});
afterAll(async () => {
  await syncCatalog(demo); // Katalog in jedem Fall auf den Code-Stand zurück
  await destroyTestContext(dev);
  await destroyTestContext(demo);
});
beforeEach(async () => {
  await resetTrainingWorld(demo.pool);
  await syncCatalog(demo);
});

async function definitionRows(ctx: TestContext) {
  return ctx.db.select().from(trainingDefinitions).orderBy(asc(trainingDefinitions.key));
}

describe('Katalog (T69–T71)', () => {
  it('T69. Definition stable key: zweimaliger Sync ⇒ identische IDs/Keys, 8 Übungen, 5 Pfade, Items je Pfad', async () => {
    const before = await definitionRows(demo);
    expect(before.map((row) => row.key)).toEqual([
      'communication_reply',
      'handover_complete',
      'inventory_stocktake_approve',
      'machine_clean_complete',
      'offer_send',
      'return_complete',
      'settlement_review',
      'tour_complete',
    ]);
    const first = await syncCatalog(demo);
    const second = await syncCatalog(demo);
    expect(first).toEqual({ definitions: 8, paths: 5, items: 8 });
    expect(second).toEqual(first);
    const after = await definitionRows(demo);
    expect(after.map((row) => [row.id, row.key, row.evaluatorKey, row.active])).toEqual(
      before.map((row) => [row.id, row.key, row.evaluatorKey, row.active]),
    );
    const paths = await demo.db.select().from(trainingPaths).orderBy(asc(trainingPaths.key));
    expect(paths.map((path) => path.key)).toEqual([
      'communication',
      'delivery_tour',
      'machines_warehouse',
      'rental_basics',
      'settlement',
    ]);
    const items = await demo.db.select().from(trainingPathItems);
    expect(items).toHaveLength(8);
  });

  it('T70. Definition Version: Katalogvariante version+1 ⇒ Spalte aktualisiert; laufender Versuch behält seine definition_version', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    const variant = catalogVariant((catalog) => {
      const definition = catalog.definitions.find((d) => d.key === 'handover_complete')!;
      definition.version += 1;
    });
    await syncCatalog(demo, variant);
    const [row] = await demo.db
      .select()
      .from(trainingDefinitions)
      .where(eq(trainingDefinitions.key, 'handover_complete'));
    expect(row!.version).toBe(2);
    const attempt = await attemptRow(demo, attemptId);
    expect(attempt.definitionVersion).toBe(1);
    expect(attempt.status).toBe('in_progress');
    const me = await trainingMe(api);
    expect(me.status).toBe(200);
    expect(me.body.activeAttempts.map((a: { id: string }) => a.id)).toEqual([attemptId]);
    expect(
      me.body.definitions.find((d: { key: string }) => d.key === 'handover_complete').version,
    ).toBe(2);
  });

  it('T71. Pfad-Reihenfolge: Items nach sequence; Umordnung im Katalog resequenziert ohne Unique-Verletzung, Item-Zeilen bleiben', async () => {
    const { cookie } = await adminSession(demo);
    const api = apiFor(demo.app, cookie);
    const itemsOf = async () => {
      const result = await api('GET', '/staff/training/admin/paths');
      expect(result.status).toBe(200);
      const path = result.body.paths.find((p: { key: string }) => p.key === 'rental_basics');
      return path.items.map((item: { sequence: number; definition: { key: string } }) => [
        item.sequence,
        item.definition.key,
      ]);
    };
    const rowIds = async () =>
      (await demo.db.select().from(trainingPathItems).orderBy(asc(trainingPathItems.id)))
        .map((row) => row.id)
        .sort();
    const original = [
      [1, 'offer_send'],
      [2, 'handover_complete'],
      [3, 'return_complete'],
    ];
    expect(await itemsOf()).toEqual(original);
    const ids = await rowIds();
    const variant = catalogVariant((catalog) => {
      const path = catalog.paths.find((p) => p.key === 'rental_basics')!;
      path.items = [
        { definitionKey: 'return_complete', sequence: 1, required: true },
        { definitionKey: 'handover_complete', sequence: 2, required: true },
        { definitionKey: 'offer_send', sequence: 3, required: true },
      ];
    });
    await expect(syncCatalog(demo, variant)).resolves.toMatchObject({ paths: 5 });
    expect(await itemsOf()).toEqual([
      [1, 'return_complete'],
      [2, 'handover_complete'],
      [3, 'offer_send'],
    ]);
    await syncCatalog(demo);
    expect(await itemsOf()).toEqual(original);
    expect(await rowIds()).toEqual(ids); // nie gelöscht/neu angelegt
  });
});

describe('Zuweisung und IDOR (T72–T74)', () => {
  it('T72. Assignment: Admin weist „Grundlagen Vermietung“ zu ⇒ /me zeigt Pfad, 3 offene Pflichtübungen, Katalog, keine Gates in demo', async () => {
    const { admin, cookie } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const adminApi = apiFor(demo.app, cookie);
    const assigned = await adminApi('POST', '/staff/training/admin/assignments', {
      userId: user.user.id,
      pathKey: 'rental_basics',
    });
    expect(assigned.status).toBe(201);
    expect(assigned.body.assignment).toMatchObject({
      path: { key: 'rental_basics', title: 'Grundlagen Vermietung' },
      status: 'assigned',
      round: 1,
      completedAt: null,
    });
    const me = await trainingMe(apiFor(demo.app, user.cookie));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ environment: 'demo', exercisesAvailable: true, gates: [] });
    expect(me.body.assignments).toHaveLength(1);
    const items = me.body.assignments[0].items;
    expect(
      items.map((item: { sequence: number; definition: { key: string }; state: string }) => [
        item.sequence,
        item.definition.key,
        item.state,
      ]),
    ).toEqual([
      [1, 'offer_send', 'open'],
      [2, 'handover_complete', 'open'],
      [3, 'return_complete', 'open'],
    ]);
    // Rechte-Vorbedingung je Übung ist sichtbar (keine Rechteerweiterung, §55).
    expect(items[0].definition.permissionMissing).toBe(true); // offer.send fehlt
    expect(items[1].definition.permissionMissing).toBe(false);
    expect(me.body.definitions).toHaveLength(8);
    expect(me.body.definitions[0]).toMatchObject({
      key: 'offer_send',
      steps: [{ key: 'edit' }, { key: 'send' }],
      seedKey: 'process.offer.draft',
      seedEntity: null, // kein Seed in dieser Test-DB ⇒ Registry leer
      state: 'open',
      attempt: null,
    });
  });

  it('T73. Nur eigener Assignment-/Attempt-Read: fremde Versuchs-ID ⇒ 404 (lesen und prüfen), /me zeigt nur Eigenes', async () => {
    const { admin, cookie } = await adminSession(demo);
    const alice = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Alice');
    const bob = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Bob');
    await apiFor(demo.app, cookie)('POST', '/staff/training/admin/assignments', {
      userId: alice.user.id,
      pathKey: 'rental_basics',
    });
    const aliceApi = apiFor(demo.app, alice.cookie);
    const bobApi = apiFor(demo.app, bob.cookie);
    const attemptId = await startedAttemptId(aliceApi, 'handover_complete');
    expect((await aliceApi('GET', `/staff/training/attempts/${attemptId}`)).status).toBe(200);
    const foreignRead = await bobApi('GET', `/staff/training/attempts/${attemptId}`);
    expect(foreignRead.status).toBe(404);
    expect(foreignRead.body.error.code).toBe('TRAINING_ATTEMPT_NOT_FOUND');
    expect((await bobApi('POST', `/staff/training/attempts/${attemptId}/check`, {})).status).toBe(
      404,
    );
    expect((await bobApi('GET', `/staff/training/attempts/${randomUUID()}`)).status).toBe(404);
    const bobMe = await trainingMe(bobApi);
    expect(bobMe.body.assignments).toEqual([]);
    expect(bobMe.body.activeAttempts).toEqual([]);
    // Versuch von Alice unverändert
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    // Admin-Routen bleiben Mitarbeitern verschlossen
    expect((await bobApi('GET', '/staff/training/admin/overview')).status).toBe(403);
  });

  it('T74. training.manage sieht alle: Übersicht enthält jeden aktiven Mitarbeiter (auch ohne Zuweisung) mit Fortschritt', async () => {
    const { admin, cookie } = await adminSession(demo);
    const alice = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Alice');
    const bob = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Bob');
    const adminApi = apiFor(demo.app, cookie);
    await adminApi('POST', '/staff/training/admin/assignments', {
      userId: alice.user.id,
      pathKey: 'rental_basics',
    });
    const attemptId = await startedAttemptId(apiFor(demo.app, alice.cookie), 'handover_complete');
    const overview = await adminApi('GET', '/staff/training/admin/overview');
    expect(overview.status).toBe(200);
    const users = overview.body.users as {
      user: { id: string };
      assignments: {
        pathKey: string;
        status: string;
        items: { definitionKey: string; state: string; lastAttempt: { status: string } | null }[];
      }[];
    }[];
    expect(users.map((entry) => entry.user.id).sort()).toEqual(
      [admin.id, alice.user.id, bob.user.id].sort(),
    );
    const aliceEntry = users.find((entry) => entry.user.id === alice.user.id)!;
    expect(aliceEntry.assignments).toHaveLength(1);
    expect(aliceEntry.assignments[0]!.status).toBe('in_progress');
    const handoverItem = aliceEntry.assignments[0]!.items.find(
      (item) => item.definitionKey === 'handover_complete',
    )!;
    expect(handoverItem).toMatchObject({
      state: 'in_progress',
      lastAttempt: { status: 'in_progress' },
    });
    expect(users.find((entry) => entry.user.id === bob.user.id)!.assignments).toEqual([]);
    // Admin sieht den fremden Versuch (kein 404)
    expect((await adminApi('GET', `/staff/training/attempts/${attemptId}`)).status).toBe(200);
  });
});

describe('Versuche (T75–T78)', () => {
  it('T75. Attempt starten: 201, in_progress, Schrittliste, offener Schritt; /me zeigt laufenden Versuch und Definition-Zustand', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const started = await startAttempt(api, 'handover_complete');
    expect(started.status).toBe(201);
    expect(started.body.attempt).toMatchObject({
      definitionKey: 'handover_complete',
      status: 'in_progress',
      completedAt: null,
      interruptedAt: null,
      interruptionCode: null,
      failedCheckCount: 0,
      lastFailedCheckAt: null,
      steps: [{ key: 'finalize', title: 'Übergabe abschließen', done: false }],
      openStep: { key: 'finalize', title: 'Übergabe abschließen' },
      assignmentId: null,
    });
    const me = await trainingMe(api);
    expect(me.body.activeAttempts.map((a: { id: string }) => a.id)).toEqual([
      started.body.attempt.id,
    ]);
    const definition = me.body.definitions.find(
      (d: { key: string }) => d.key === 'handover_complete',
    );
    expect(definition).toMatchObject({ state: 'in_progress', passedAt: null });
    expect(definition.attempt.id).toBe(started.body.attempt.id);
    // Unbekannter Key ⇒ 404
    expect((await startAttempt(api, 'does_not_exist')).status).toBe(404);
  });

  it('T76. Doppelklick ⇒ ein Attempt: zwei parallele POSTs liefern dieselbe ID, genau 1 in_progress in der DB', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const [first, second] = await Promise.all([
      startAttempt(api, 'handover_complete'),
      startAttempt(api, 'handover_complete'),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.attempt.id).toBe(second.body.attempt.id);
    const rows = await demo.db
      .select()
      .from(trainingAttempts)
      .where(
        and(eq(trainingAttempts.userId, user.user.id), eq(trainingAttempts.status, 'in_progress')),
      );
    expect(rows).toHaveLength(1);
    // Dritter (sequentieller) Klick ⇒ 200 mit derselben ID
    const third = await startAttempt(api, 'handover_complete');
    expect(third.status).toBe(200);
    expect(third.body.attempt.id).toBe(first.body.attempt.id);
  });

  it('T77. Zweiter User eigener Attempt: beide Mitarbeiter haben je einen eigenen laufenden Versuch derselben Übung', async () => {
    const { admin } = await adminSession(demo);
    const alice = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Alice');
    const bob = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Bob');
    const a = await startedAttemptId(apiFor(demo.app, alice.cookie), 'handover_complete');
    const b = await startedAttemptId(apiFor(demo.app, bob.cookie), 'handover_complete');
    expect(a).not.toBe(b);
    expect((await attemptRow(demo, a)).userId).toBe(alice.user.id);
    expect((await attemptRow(demo, b)).userId).toBe(bob.user.id);
    expect((await attemptsOfUser(demo, alice.user.id)).map((row) => row.id)).toEqual([a]);
    expect((await attemptsOfUser(demo, bob.user.id)).map((row) => row.id)).toEqual([b]);
  });

  it('T78. Anderer User Event zählt nicht: Ereignis mit Akteur Bob lässt Alices Versuch unberührt', async () => {
    const { admin } = await adminSession(demo);
    const alice = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Alice');
    const bob = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Bob');
    const attemptId = await startedAttemptId(apiFor(demo.app, alice.cookie), 'handover_complete');
    await demo.trainingRecorder.record({
      actorUserId: bob.user.id,
      eventKey: 'handover.finalized',
      subjectRef: randomUUID(),
    });
    expect((await attemptRow(demo, attemptId)).status).toBe('in_progress');
    expect(await eventsOf(demo, attemptId)).toEqual([]);
    expect(await demo.db.select().from(trainingAttemptEvents)).toEqual([]);
  });
});

describe('Recorder-Grenzen (T79–T80)', () => {
  it('T79. Event außerhalb Demo zählt nicht: development ⇒ Recorder Noop, keine Ereigniszeilen, Attempt-Routen 404, /me und Katalog verfügbar', async () => {
    const { admin, cookie } = await adminSession(dev);
    const api = apiFor(dev.app, cookie);
    const world = await createCommerceWorld(dev, admin.id);
    const created = await api('POST', `/staff/processes/${world.processId}/offer`);
    expect(created.status).toBe(200);
    await dev.trainingRecorder.record({
      actorUserId: admin.id,
      eventKey: 'offer.draft_created',
      subjectRef: created.body.offerId,
    });
    expect(await dev.db.select().from(trainingAttemptEvents)).toEqual([]);
    expect(await dev.db.select().from(trainingAttempts)).toEqual([]);
    expect((await startAttempt(api, 'offer_send')).status).toBe(404);
    expect((await api('GET', `/staff/training/attempts/${randomUUID()}`)).status).toBe(404);
    expect((await api('GET', '/staff/training/admin/overview')).status).toBe(404);
    const me = await trainingMe(api);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ environment: 'development', exercisesAvailable: false });
    expect(Array.isArray(me.body.gates)).toBe(true);
    expect(me.body.definitions).toHaveLength(8);
    const definitions = await api('GET', '/staff/training/definitions');
    expect(definitions.status).toBe(200);
    expect(definitions.body.definitions.map((d: { key: string }) => d.key)).toContain('offer_send');
  });

  it('T80. Event nach Rollback zählt nicht: fehlgeschlagene Finalisierung (409) erzeugt kein Ereignis, Versuch bleibt offen', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    const booking = await scheduledBooking(demo, admin.id);
    await handoverServicesFor(demo).handover.ensureForBooking(booking.bookingId, admin.id);
    const finalize = await api('POST', `/staff/handover/${booking.bookingId}/finalize`, {});
    expect(finalize.status).toBe(409);
    expect(finalize.body.error.code).toBe('CONFLICT');
    expect(await eventsOf(demo, attemptId)).toEqual([]);
    const attempt = await attemptRow(demo, attemptId);
    expect(attempt.status).toBe('in_progress');
    expect(attempt.failedCheckCount).toBe(0); // Businessfehler ≠ Trainingsfehler (§80)
  });
});

describe('Prüfen, Bestehen, Duplikate (T81–T83)', () => {
  it('T81. Fehlender Step ⇒ „Übung prüfen“: failed_check_count +1, Ereignis check_failed mit offenem Schritt und STEP_NOT_COMPLETED', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    const first = await checkAttempt(api, attemptId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      passed: false,
      openStep: { key: 'finalize', title: 'Übergabe abschließen' },
      attempt: { status: 'in_progress', failedCheckCount: 1 },
    });
    expect(first.body.attempt.lastFailedCheckAt).not.toBeNull();
    const second = await checkAttempt(api, attemptId);
    expect(second.body.attempt.failedCheckCount).toBe(2);
    const events = await eventsOf(demo, attemptId);
    expect(events.map((e) => [e.result, e.stepKey, e.errorCode])).toEqual([
      ['check_failed', 'finalize', TRAINING_ERROR_CODES.STEP_NOT_COMPLETED],
      ['check_failed', 'finalize', TRAINING_ERROR_CODES.STEP_NOT_COMPLETED],
    ]);
    const row = await attemptRow(demo, attemptId);
    expect(row.failedCheckCount).toBe(2);
    expect(row.lastFailedCheckAt).not.toBeNull();
  });

  it('T82. Vollständiger Evaluator ⇒ passed: das letzte Pflicht-Ereignis schließt den Versuch automatisch ab (completed_at, Ereignis accepted); Prüfen danach bestätigt', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    const bookingId = randomUUID();
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'handover.finalized',
      subjectRef: bookingId,
    });
    const row = await attemptRow(demo, attemptId);
    expect(row.status).toBe('passed');
    expect(row.completedAt).not.toBeNull();
    expect(row.failedCheckCount).toBe(0);
    const events = await eventsOf(demo, attemptId);
    expect(events.map((e) => [e.eventKey, e.stepKey, e.result, e.subjectRef])).toEqual([
      ['handover.finalized', 'finalize', 'accepted', bookingId],
    ]);
    const me = await trainingMe(api);
    expect(me.body.activeAttempts).toEqual([]);
    const definition = me.body.definitions.find(
      (d: { key: string }) => d.key === 'handover_complete',
    );
    expect(definition.state).toBe('passed');
    expect(definition.passedAt).toBe(row.completedAt!.toISOString());
    expect(definition.attempt.steps).toEqual([
      { key: 'finalize', title: 'Übergabe abschließen', done: true },
    ]);
    const check = await checkAttempt(api, attemptId);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      passed: true,
      openStep: null,
      attempt: { status: 'passed' },
    });
    expect((await eventsOf(demo, attemptId)).length).toBe(1); // bestätigte Prüfung erzeugt kein zweites Ereignis
  });

  it('T83. Duplicate Event ⇒ kein Doppelabschluss: zweites Ereignis wird als duplicate protokolliert, completed_at unverändert, genau ein bestandener Versuch', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    const event = {
      actorUserId: user.user.id,
      eventKey: 'handover.finalized' as const,
      subjectRef: randomUUID(),
    };
    await demo.trainingRecorder.record(event);
    const passedAt = (await attemptRow(demo, attemptId)).completedAt;
    expect(passedAt).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await demo.trainingRecorder.record(event);
    await demo.trainingRecorder.record({ ...event, subjectRef: randomUUID() });
    const row = await attemptRow(demo, attemptId);
    expect(row.status).toBe('passed');
    expect(row.completedAt!.toISOString()).toBe(passedAt!.toISOString());
    // Nach dem Abschluss ist der Versuch nicht mehr „laufend“ ⇒ weitere Ereignisse erzeugen keine Zeilen mehr.
    expect((await eventsOf(demo, attemptId)).map((e) => e.result)).toEqual(['accepted']);
    const passed = (await attemptsOfUser(demo, user.user.id)).filter((a) => a.status === 'passed');
    expect(passed).toHaveLength(1);
    // Duplikat innerhalb eines laufenden Mehrschritt-Versuchs wird als `duplicate` festgehalten.
    const tourUser = await trainee(demo, admin.id, ['calendar.view'], 'Fahrer');
    const tourAttempt = await startedAttemptId(apiFor(demo.app, tourUser.cookie), 'tour_complete');
    const tourId = randomUUID();
    await demo.trainingRecorder.record({
      actorUserId: tourUser.user.id,
      eventKey: 'tour.ready',
      subjectRef: tourId,
    });
    await demo.trainingRecorder.record({
      actorUserId: tourUser.user.id,
      eventKey: 'tour.planned',
      subjectRef: tourId,
    });
    expect((await eventsOf(demo, tourAttempt)).map((e) => [e.stepKey, e.result])).toEqual([
      ['plan', 'accepted'],
      ['plan', 'duplicate'],
    ]);
    expect((await attemptRow(demo, tourAttempt)).status).toBe('in_progress');
  });
});

describe('Stabilität (T84, T87, T88)', () => {
  it('T84. Passed bleibt nach Definition-Update: Sync mit neuer Version und neuem Titel ändert den bestandenen Versuch nicht', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'handover.finalized',
      subjectRef: randomUUID(),
    });
    const before = await attemptRow(demo, attemptId);
    expect(before.status).toBe('passed');
    const variant = catalogVariant((catalog) => {
      const definition = catalog.definitions.find((d) => d.key === 'handover_complete')!;
      definition.version = 3;
      definition.title = 'Übergabe abschließen (überarbeitet)';
      definition.instructions = 'Neue Anleitung.';
    });
    await syncCatalog(demo, variant);
    const after = await attemptRow(demo, attemptId);
    expect(after).toMatchObject({
      status: 'passed',
      definitionVersion: 1,
      supersededAt: null,
      completedAt: before.completedAt,
    });
    const me = await trainingMe(api);
    const definition = me.body.definitions.find(
      (d: { key: string }) => d.key === 'handover_complete',
    );
    expect(definition).toMatchObject({
      version: 3,
      title: 'Übergabe abschließen (überarbeitet)',
      state: 'passed',
    });
    await syncCatalog(demo);
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
  });

  it('T87. Training-Reset erhält Historie: Versuche bleiben (superseded), Runde +1, Fortschritt leer, neuer Versuch möglich', async () => {
    const { admin, cookie } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const adminApi = apiFor(demo.app, cookie);
    const api = apiFor(demo.app, user.cookie);
    await adminApi('POST', '/staff/training/admin/assignments', {
      userId: user.user.id,
      pathKey: 'rental_basics',
    });
    const attemptId = await startedAttemptId(api, 'handover_complete');
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'handover.finalized',
      subjectRef: randomUUID(),
    });
    expect((await attemptRow(demo, attemptId)).assignmentRound).toBe(1);
    const reset = await adminApi('POST', '/staff/training/admin/reset', {
      userId: user.user.id,
      pathKey: 'rental_basics',
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({
      interruptedAttempts: 0,
      supersededAttempts: 1,
      resetAssignments: 1,
    });
    const history = await attemptsOfUser(demo, user.user.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: attemptId, status: 'passed', supersededBy: admin.id });
    expect(history[0]!.supersededAt).not.toBeNull();
    expect(await eventsOf(demo, attemptId)).toHaveLength(1); // Ereignisse bleiben
    const [assignment] = await demo.db
      .select()
      .from(trainingAssignments)
      .where(eq(trainingAssignments.userId, user.user.id));
    expect(assignment).toMatchObject({
      round: 2,
      status: 'assigned',
      completedAt: null,
      lastResetBy: admin.id,
    });
    expect(assignment!.lastResetAt).not.toBeNull();
    const me = await trainingMe(api);
    const item = me.body.assignments[0].items.find(
      (candidate: { definition: { key: string } }) =>
        candidate.definition.key === 'handover_complete',
    );
    expect(item).toMatchObject({ state: 'open', passedAt: null, attempt: null });
    expect(me.body.assignments[0].round).toBe(2);
    const again = await startAttempt(api, 'handover_complete');
    expect(again.status).toBe(201);
    expect(again.body.attempt.id).not.toBe(attemptId);
    expect((await attemptRow(demo, again.body.attempt.id)).assignmentRound).toBe(2);
    expect(await attemptsOfUser(demo, user.user.id)).toHaveLength(2);
  });

  it('T88. Inaktive Definition nicht startbar: Katalogvariante active=false ⇒ 409 TRAINING_DEFINITION_INACTIVE, nicht im Katalog; nach Re-Sync wieder startbar', async () => {
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const api = apiFor(demo.app, user.cookie);
    await syncCatalog(
      demo,
      catalogVariant((catalog) => {
        catalog.definitions.find((d) => d.key === 'handover_complete')!.active = false;
      }),
    );
    const blocked = await startAttempt(api, 'handover_complete');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({
      code: TRAINING_ERROR_CODES.DEFINITION_INACTIVE,
      details: { definitionKey: 'handover_complete' },
    });
    const me = await trainingMe(api);
    expect(me.body.definitions.map((d: { key: string }) => d.key)).not.toContain(
      'handover_complete',
    );
    await syncCatalog(demo);
    expect((await startAttempt(api, 'handover_complete')).status).toBe(201);
  });
});

describe('Demo-Reset (T85, T86)', () => {
  /**
   * Echter Reset über die Route (Phase A–D inkl. kanonischem Seed) mit dem
   * Hook aus app.ts – je Test neu, weil das Top-Level-beforeEach den
   * Fortschritt leert (Hook-Reihenfolge).
   */
  async function resetScenario() {
    const { admin, cookie } = await adminSession(demo);
    const alice = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Alice');
    const bob = await trainee(demo, admin.id, HANDOVER_PERMISSIONS, 'Bob');
    const adminApi = apiFor(demo.app, cookie);
    expect(
      (
        await adminApi('POST', '/staff/training/admin/assignments', {
          userId: alice.user.id,
          pathKey: 'rental_basics',
        })
      ).status,
    ).toBe(201);
    const alicePassedId = await startedAttemptId(
      apiFor(demo.app, alice.cookie),
      'handover_complete',
    );
    await demo.trainingRecorder.record({
      actorUserId: alice.user.id,
      eventKey: 'handover.finalized',
      subjectRef: randomUUID(),
    });
    const bobAttemptId = await startedAttemptId(apiFor(demo.app, bob.cookie), 'handover_complete');
    const reset = await adminApi('POST', '/staff/demo/reset', {
      confirmation: DEMO_MESSAGES.RESET_CONFIRMATION,
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    return { alice, bob, alicePassedId, bobAttemptId };
  }

  it('T85. Demo-Reset lässt passed bestehen: bestandener Versuch, seine Ereignisse und die Zuweisung bleiben (nicht supersediert)', async () => {
    const { alice, alicePassedId } = await resetScenario();
    const row = await attemptRow(demo, alicePassedId);
    expect(row).toMatchObject({ status: 'passed', supersededAt: null, interruptionCode: null });
    expect((await eventsOf(demo, alicePassedId)).map((e) => e.result)).toEqual(['accepted']);
    const assignments = await demo.db
      .select()
      .from(trainingAssignments)
      .where(eq(trainingAssignments.userId, alice.user.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.round).toBe(1);
    // Katalog unangetastet
    expect(await definitionRows(demo)).toHaveLength(8);
    // Audit des Resets ohne Trainingsinhalte
    const audit = await demo.db.select().from(staffSecurityEvents);
    expect(audit.some((event) => event.type === 'demo.reset_completed')).toBe(true);
    // /me zeigt die Übung weiterhin als bestanden
    const me = await trainingMe(apiFor(demo.app, alice.cookie));
    expect(
      me.body.definitions.find((d: { key: string }) => d.key === 'handover_complete').state,
    ).toBe('passed');
  }, 180_000);

  it('T86. Demo-Reset unterbricht in_progress: Versuch interrupted mit DEMO_DATA_RESET und Ereignis interrupted; Neustart möglich', async () => {
    const { bob, bobAttemptId } = await resetScenario();
    const row = await attemptRow(demo, bobAttemptId);
    expect(row).toMatchObject({
      status: 'interrupted',
      interruptionCode: DEMO_RESET_INTERRUPTION_CODE,
    });
    expect(row.interruptedAt).not.toBeNull();
    expect((await eventsOf(demo, bobAttemptId)).map((e) => [e.result, e.errorCode])).toEqual([
      ['interrupted', DEMO_RESET_INTERRUPTION_CODE],
    ]);
    const api = apiFor(demo.app, bob.cookie);
    const me = await trainingMe(api);
    expect(me.status).toBe(200);
    const definition = me.body.definitions.find(
      (d: { key: string }) => d.key === 'handover_complete',
    );
    expect(definition).toMatchObject({
      state: 'open',
      attempt: {
        id: bobAttemptId,
        status: 'interrupted',
        interruptionCode: DEMO_RESET_INTERRUPTION_CODE,
      },
    });
    expect(me.body.activeAttempts).toEqual([]);
    // Seed-Szenario der Übung ist nach dem Reset über die Registry auflösbar (§72).
    expect(definition.seedEntity).toMatchObject({ entityType: 'process' });
    expect((await checkAttempt(api, bobAttemptId)).status).toBe(409);
    expect((await startAttempt(api, 'handover_complete')).status).toBe(201);
  }, 180_000);
});

describe('Datenminimierung (T89)', () => {
  it('T89. Keine Businessdaten im TrainingEvent: Spalten sind reine Metadaten, Inhalte nur Keys/Codes/IDs/Zeitpunkte', async () => {
    const columns = await demo.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'training_attempt_events' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'attempt_id',
      'error_code',
      'event_key',
      'id',
      'occurred_at',
      'result',
      'step_key',
      'subject_ref',
    ]);
    const attemptColumns = await demo.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'training_attempts' ORDER BY column_name`,
    );
    expect(attemptColumns.rows.map((row) => row.column_name)).toEqual([
      'assignment_id',
      'assignment_round',
      'completed_at',
      'definition_id',
      'definition_version',
      'failed_check_count',
      'id',
      'interrupted_at',
      'interruption_code',
      'last_failed_check_at',
      'started_at',
      'status',
      'superseded_at',
      'superseded_by',
      'updated_at',
      'user_id',
    ]);
    // Inhaltsprüfung nach echten Ereignissen (accepted, rejected, duplicate, check_failed).
    const { admin } = await adminSession(demo);
    const user = await trainee(demo, admin.id, ['calendar.view'], 'Fahrer');
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'tour_complete');
    const tourId = randomUUID();
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'tour.started',
      subjectRef: tourId,
    });
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'tour.ready',
      subjectRef: tourId,
    });
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'tour.planned',
      subjectRef: tourId,
    });
    await checkAttempt(api, attemptId);
    const events = await eventsOf(demo, attemptId);
    expect(events.map((e) => e.result)).toEqual([
      'rejected',
      'accepted',
      'duplicate',
      'check_failed',
    ]);
    for (const event of events) {
      expect(event.eventKey).toMatch(/^[a-z][a-z0-9_.]*$/);
      expect(event.stepKey === null || /^[a-z_]+$/.test(event.stepKey)).toBe(true);
      expect(event.errorCode === null || /^[A-Z][A-Z0-9_]*$/.test(event.errorCode)).toBe(true);
      expect(event.subjectRef === null || /^[0-9a-f-]{36}$/.test(event.subjectRef)).toBe(true);
      expect(JSON.stringify(event)).not.toMatch(/@|€|Mainz|Kunde/);
    }
    // Die Versuchsansicht gibt das Fachobjekt nicht nach außen (nur Meta).
    const detail = await api('GET', `/staff/training/attempts/${attemptId}`);
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body.events[0]).sort()).toEqual([
      'errorCode',
      'eventKey',
      'occurredAt',
      'result',
      'stepKey',
    ]);
  });
});
