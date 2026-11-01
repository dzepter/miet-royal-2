import { randomUUID } from 'node:crypto';
import { staffSecurityEvents, trainingAssignments } from '@mietroyal/database';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRAINING_ERROR_CODES } from '../src/training/errors.ts';
import { TRAINING_RESET_INTERRUPTION_CODE } from '../src/training/training-service.ts';
import { destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createTestCustomer, processServiceFor } from './crm-helpers.ts';
import {
  adminSession,
  apiFor,
  attemptRow,
  attemptsOfUser,
  checkAttempt,
  createTrainingDemoContext,
  eventsOf,
  resetTrainingWorld,
  startedAttemptId,
  syncCatalog,
  trainee,
  type Api,
} from './training-helpers.ts';

/**
 * Phase 14 (Training, Order §108 – Pflichttests 119–123, Design §4.7): Demo-
 * Verwaltung mit `training.manage` – Pfad zuweisen, Fortschritt zurücksetzen
 * (Historie bleibt), Fortschritt und Fehlercodes sehen, keine Businessinhalte
 * in den Admin-Antworten; Audit `training.assignment_created/_reset`.
 */

const HANDOVER_PERMISSIONS = ['handover.view', 'handover.perform', 'process.view_all'] as const;

let demo: TestContext;

beforeAll(async () => {
  demo = await createTrainingDemoContext();
});
afterAll(async () => {
  await syncCatalog(demo);
  await destroyTestContext(demo);
});
beforeEach(async () => {
  await resetTrainingWorld(demo.pool);
});

async function auditEvents(type: string) {
  return (
    await demo.db.select().from(staffSecurityEvents).orderBy(asc(staffSecurityEvents.createdAt))
  ).filter((event) => event.type === type);
}

async function assign(adminApi: Api, userId: string, pathKey: string, dueAt?: string) {
  return adminApi('POST', '/staff/training/admin/assignments', {
    userId,
    pathKey,
    ...(dueAt === undefined ? {} : { dueAt }),
  });
}

describe('Admin-Training in der Demo (T119–T123)', () => {
  it('T119. Pfad zuweisen: 201 mit Zuweisung; Duplikat 409; unbekannter Pfad 404; ohne training.manage 403; Audit training.assignment_created nur mit IDs/Keys', async () => {
    const { admin, cookie } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const adminApi = apiFor(demo.app, cookie);
    const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const created = await assign(adminApi, user.user.id, 'rental_basics', dueAt);
    expect(created.status).toBe(201);
    expect(created.body.assignment).toMatchObject({
      path: { key: 'rental_basics', title: 'Grundlagen Vermietung' },
      status: 'assigned',
      round: 1,
      dueAt,
      completedAt: null,
    });
    expect(created.body.assignment.items).toHaveLength(3);
    const duplicate = await assign(adminApi, user.user.id, 'rental_basics');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe(TRAINING_ERROR_CODES.ASSIGNMENT_EXISTS);
    expect((await assign(adminApi, user.user.id, 'unknown_path')).status).toBe(404);
    expect((await assign(adminApi, randomUUID(), 'rental_basics')).status).toBe(404);
    expect(
      (await assign(apiFor(demo.app, user.cookie), user.user.id, 'delivery_tour')).status,
    ).toBe(403);
    // Zusätzliche Felder werden abgelehnt (strict schema).
    expect(
      (
        await adminApi('POST', '/staff/training/admin/assignments', {
          userId: user.user.id,
          pathKey: 'delivery_tour',
          status: 'completed',
        })
      ).status,
    ).toBe(400);
    const audit = await auditEvents('training.assignment_created');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: admin.id, targetUserId: user.user.id });
    expect(Object.keys(audit[0]!.details as object).sort()).toEqual([
      'assignmentId',
      'dueAt',
      'pathKey',
    ]);
    expect(audit[0]!.details).toMatchObject({
      assignmentId: created.body.assignment.id,
      pathKey: 'rental_basics',
    });
    const rows = await demo.db.select().from(trainingAssignments);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assignedBy).toBe(admin.id);
  });

  it('T120. Assignment reset: bestandene Versuche werden supersediert, laufende unterbrochen (TRAINING_RESET), Runde +1, Historie bleibt, Audit training.assignment_reset', async () => {
    const { admin, cookie } = await adminSession(demo);
    const user = await trainee(demo, admin.id, [...HANDOVER_PERMISSIONS, 'return.complete']);
    const adminApi = apiFor(demo.app, cookie);
    const api = apiFor(demo.app, user.cookie);
    expect((await assign(adminApi, user.user.id, 'rental_basics')).status).toBe(201);
    const passedId = await startedAttemptId(api, 'handover_complete');
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'handover.finalized',
      subjectRef: randomUUID(),
    });
    const runningId = await startedAttemptId(api, 'return_complete');
    const [before] = await demo.db.select().from(trainingAssignments);
    expect(before!.status).toBe('in_progress');
    expect(
      (
        await adminApi('POST', '/staff/training/admin/reset', {
          userId: user.user.id,
          pathKey: 'x',
          definitionKey: 'y',
        })
      ).status,
    ).toBe(400);
    expect(
      (await api('POST', '/staff/training/admin/reset', { userId: user.user.id })).status,
    ).toBe(403);
    const reset = await adminApi('POST', '/staff/training/admin/reset', {
      userId: user.user.id,
      pathKey: 'rental_basics',
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({
      interruptedAttempts: 1,
      supersededAttempts: 1,
      resetAssignments: 1,
    });
    const history = await attemptsOfUser(demo, user.user.id);
    expect(history).toHaveLength(2);
    const passed = history.find((row) => row.id === passedId)!;
    expect(passed).toMatchObject({ status: 'passed', supersededBy: admin.id });
    expect(passed.supersededAt).not.toBeNull();
    const running = history.find((row) => row.id === runningId)!;
    expect(running).toMatchObject({
      status: 'interrupted',
      interruptionCode: TRAINING_RESET_INTERRUPTION_CODE,
    });
    expect((await eventsOf(demo, runningId)).map((e) => [e.result, e.errorCode])).toEqual([
      ['interrupted', TRAINING_RESET_INTERRUPTION_CODE],
    ]);
    const [after] = await demo.db.select().from(trainingAssignments);
    expect(after).toMatchObject({
      round: 2,
      status: 'assigned',
      completedAt: null,
      lastResetBy: admin.id,
    });
    const audit = await auditEvents('training.assignment_reset');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: admin.id, targetUserId: user.user.id });
    expect(audit[0]!.details).toEqual({
      scope: 'path',
      pathKey: 'rental_basics',
      definitionKey: null,
      interruptedAttempts: 1,
      supersededAttempts: 1,
      resetAssignments: 1,
    });
    // Reset einer einzelnen Übung (ohne Zuweisungsbezug) ist ebenfalls möglich und idempotent.
    const single = await adminApi('POST', '/staff/training/admin/reset', {
      userId: user.user.id,
      definitionKey: 'handover_complete',
    });
    expect(single.status).toBe(200);
    expect(single.body).toEqual({
      interruptedAttempts: 0,
      supersededAttempts: 0,
      resetAssignments: 1,
    });
    expect((await demo.db.select().from(trainingAssignments))[0]!.round).toBe(3);
  });

  it('T121. Fortschritt sehen: Übersicht und Mitarbeiterdetail zeigen Zustand je Übung, letzten Versuch, Fehlversuche und unterbrochene Versuche', async () => {
    const { admin, cookie } = await adminSession(demo);
    const user = await trainee(demo, admin.id, [
      ...HANDOVER_PERMISSIONS,
      'offer.edit_draft',
      'offer.send',
    ]);
    const adminApi = apiFor(demo.app, cookie);
    const api = apiFor(demo.app, user.cookie);
    expect((await assign(adminApi, user.user.id, 'rental_basics')).status).toBe(201);
    const handoverId = await startedAttemptId(api, 'handover_complete');
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'handover.finalized',
      subjectRef: randomUUID(),
    });
    const offerId = await startedAttemptId(api, 'offer_send');
    await checkAttempt(api, offerId);
    const overview = await adminApi('GET', '/staff/training/admin/overview');
    expect(overview.status).toBe(200);
    const entry = overview.body.users.find(
      (u: { user: { id: string } }) => u.user.id === user.user.id,
    );
    expect(entry).toMatchObject({ interruptedAttempts: 0, failedChecks: 1 });
    expect(entry.assignments).toHaveLength(1);
    expect(entry.assignments[0]).toMatchObject({
      pathKey: 'rental_basics',
      pathTitle: 'Grundlagen Vermietung',
      status: 'in_progress',
      round: 1,
    });
    expect(
      entry.assignments[0].items.map(
        (item: {
          definitionKey: string;
          state: string;
          lastAttempt: { status: string; failedCheckCount: number } | null;
        }) => [
          item.definitionKey,
          item.state,
          item.lastAttempt?.status ?? null,
          item.lastAttempt?.failedCheckCount ?? null,
        ],
      ),
    ).toEqual([
      ['offer_send', 'in_progress', 'in_progress', 1],
      ['handover_complete', 'passed', 'passed', 0],
      ['return_complete', 'open', null, null],
    ]);
    const detail = await adminApi('GET', `/staff/training/admin/users/${user.user.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.user).toEqual({
      id: user.user.id,
      firstName: 'Trainee',
      lastName: expect.any(String),
    });
    expect(detail.body.assignments[0].items[1]).toMatchObject({
      definition: { key: 'handover_complete' },
      state: 'passed',
    });
    expect(detail.body.assignments[0].items[1].passedAt).not.toBeNull();
    expect(
      detail.body.attempts.map((a: { id: string; status: string; definitionTitle: string }) => [
        a.id,
        a.status,
        a.definitionTitle,
      ]),
    ).toEqual([
      [offerId, 'in_progress', 'Angebot bearbeiten und versenden'],
      [handoverId, 'passed', 'Übergabe abschließen'],
    ]);
    // Nach einem Training-Reset zählt der unterbrochene Versuch in der Übersicht.
    await adminApi('POST', '/staff/training/admin/reset', { userId: user.user.id });
    const afterReset = await adminApi('GET', '/staff/training/admin/overview');
    const resetEntry = afterReset.body.users.find(
      (u: { user: { id: string } }) => u.user.id === user.user.id,
    );
    expect(resetEntry.interruptedAttempts).toBe(1);
    expect(resetEntry.assignments[0]).toMatchObject({ status: 'assigned', round: 2 });
    expect((await adminApi('GET', `/staff/training/admin/users/${randomUUID()}`)).status).toBe(404);
  });

  it('T122. Fehlercode sehen: Admin sieht Zeitpunkt, Übung, Schritt und neutralen Code (STEP_NOT_COMPLETED, PREREQUISITE_MISSING) – nie Businessdaten', async () => {
    const { admin, cookie } = await adminSession(demo);
    const user = await trainee(demo, admin.id, ['calendar.view']);
    const adminApi = apiFor(demo.app, cookie);
    const api = apiFor(demo.app, user.cookie);
    const attemptId = await startedAttemptId(api, 'tour_complete');
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'tour.started',
      subjectRef: randomUUID(),
    });
    await checkAttempt(api, attemptId);
    const detail = await adminApi('GET', `/staff/training/admin/users/${user.user.id}`);
    expect(detail.status).toBe(200);
    const attempt = detail.body.attempts.find((a: { id: string }) => a.id === attemptId);
    expect(attempt).toMatchObject({
      status: 'in_progress',
      failedCheckCount: 1,
      openStep: { key: 'plan' },
    });
    expect(
      attempt.events.map(
        (e: {
          eventKey: string;
          stepKey: string | null;
          result: string;
          errorCode: string | null;
        }) => [e.eventKey, e.stepKey, e.result, e.errorCode],
      ),
    ).toEqual([
      ['tour.started', 'start', 'rejected', 'PREREQUISITE_MISSING'],
      ['training.check', 'plan', 'check_failed', TRAINING_ERROR_CODES.STEP_NOT_COMPLETED],
    ]);
    for (const event of attempt.events) {
      expect(Object.keys(event).sort()).toEqual([
        'errorCode',
        'eventKey',
        'occurredAt',
        'result',
        'stepKey',
      ]);
      expect(typeof event.occurredAt).toBe('string');
    }
    // Dieselben Ereignisse über die Versuchsroute (Admin darf fremde Versuche lesen).
    const direct = await adminApi('GET', `/staff/training/attempts/${attemptId}`);
    expect(direct.status).toBe(200);
    expect(direct.body.events).toHaveLength(2);
  });

  it('T123. Keine Businessinhalte: Übersicht/Detail/Versuch enthalten nur Trainings-Metadaten – keine Kunden-, Vorgangs- oder Kontaktdaten', async () => {
    const { admin, cookie } = await adminSession(demo);
    const user = await trainee(demo, admin.id, HANDOVER_PERMISSIONS);
    const adminApi = apiFor(demo.app, cookie);
    const api = apiFor(demo.app, user.cookie);
    const customer = await createTestCustomer(demo, admin.id, {
      firstName: 'Klara',
      lastName: 'Kommerz',
      email: 'klara.kommerz@example.com',
      phone: '0171 9998877',
    });
    const process = await processServiceFor(demo).createProcess(admin.id, {
      customerId: customer.id,
    });
    expect((await assign(adminApi, user.user.id, 'rental_basics')).status).toBe(201);
    const attemptId = await startedAttemptId(api, 'handover_complete');
    await demo.trainingRecorder.record({
      actorUserId: user.user.id,
      eventKey: 'handover.finalized',
      subjectRef: process.id,
    });
    expect((await attemptRow(demo, attemptId)).status).toBe('passed');
    const responses = [
      await adminApi('GET', '/staff/training/admin/overview'),
      await adminApi('GET', `/staff/training/admin/users/${user.user.id}`),
      await adminApi('GET', `/staff/training/attempts/${attemptId}`),
      await api('GET', '/staff/training/me'),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('Kommerz');
      expect(text).not.toContain('Klara');
      expect(text).not.toContain('@');
      expect(text).not.toContain('9998877');
      expect(text).not.toContain(process.processNumber);
      expect(text).not.toContain(process.id); // Fachobjekt-IDs bleiben intern (subjectRef nur in der DB)
    }
    // Statische Form der Admin-Antworten (Schlüssel-Whitelist).
    const overview = responses[0]!.body.users.find(
      (u: { user: { id: string } }) => u.user.id === user.user.id,
    );
    expect(Object.keys(overview).sort()).toEqual([
      'assignments',
      'failedChecks',
      'interruptedAttempts',
      'user',
    ]);
    expect(Object.keys(overview.user).sort()).toEqual(['firstName', 'id', 'lastName']);
    expect(Object.keys(overview.assignments[0]).sort()).toEqual([
      'items',
      'pathKey',
      'pathTitle',
      'round',
      'status',
    ]);
    expect(Object.keys(overview.assignments[0].items[0]).sort()).toEqual([
      'definitionKey',
      'lastAttempt',
      'state',
      'title',
    ]);
    const detail = responses[1]!.body;
    expect(Object.keys(detail).sort()).toEqual(['assignments', 'attempts', 'user']);
    expect(Object.keys(detail.attempts[0]).sort()).toEqual([
      'assignmentId',
      'assignmentRound',
      'completedAt',
      'definitionKey',
      'definitionTitle',
      'definitionVersion',
      'events',
      'failedCheckCount',
      'id',
      'interruptedAt',
      'interruptionCode',
      'lastFailedCheckAt',
      'openStep',
      'startedAt',
      'status',
      'steps',
      'supersededAt',
    ]);
  });
});
