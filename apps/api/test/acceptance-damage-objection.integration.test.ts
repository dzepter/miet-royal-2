/**
 * Phase 18 (Gesamt-Abnahme) – Szenario B „Schaden“ und Szenario C „Kundeneinspruch/
 * Widerspruch“ als zusammenhängender API-Integrationslauf gegen echte Services
 * (Fakes nur für Mailversand und Buchhaltung, Zeit nur per vorhandenem SQL-Backdating).
 *
 * Szenario B (Karte B, Prozess B): Ein Schaden entsteht ausschließlich im Rückgabe-
 * Entwurf (strikter Body ohne Betrag, ≥ 1 Markierung), das Pflichtfoto blockiert die
 * Finalisierung, die (doppelt ausgelöste) Finalisierung aktiviert den Schaden genau
 * einmal, stellt die Maschine in Reinigung und erzeugt genau eine Abrechnung mit genau
 * einer Klärung. Kosten entstehen nur per Kostenentscheid (zwei Mitarbeiter gleichzeitig
 * ⇒ eine Position, ein 409). Ein Schaden der Vermietung A kann nie an Vermietung B hängen
 * (Adversarial P): Nachtrag nach Ausgabe an B ⇒ 409, fremder Rückgabeabschnitt ⇒ 404.
 * Rechte werden serverseitig geprüft (403 ohne Zeile); das Portal zeigt während der
 * Klärung nur „Rechnung wird vorbereitet“ – nie Klärungen, Positionen oder Beträge.
 *
 * Szenario C (Karte B, Prozess C): „Einspruch“ existiert im System nur als interne
 * Staff-Aktion „Kundenrückmeldung eingegangen“ auf der Abrechnung (Phase 9 §30). Eine
 * Portalnachricht zählt nie automatisch. Die Rückmeldung geht weder durch Neuladen noch
 * durch den fälligen Auto-Job noch durch einen konkurrierenden Request verloren; danach
 * ist nur der manuelle Transfer möglich, anschließend ist alles gesperrt.
 *
 * Die Tests teilen bewusst Zustand in Reihenfolge (Vermietung A durchläuft B1 → C4);
 * am Ende laufen die systemweiten SQL-Invarianten (acceptance-integrity.ts).
 */
import {
  accountingTransfers,
  documents,
  integrationJobs,
  machineAssignments,
  machineDamages,
  processes,
  rentalReturns,
  settlementClarifications,
  settlementCustomerNotices,
  settlementLines,
  settlements,
} from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PortalBookingView, PortalDocumentView } from '../src/portal/views.ts';
import type { NoticeView, SettlementView } from '../src/settlement/settlement-service.ts';
import {
  INTEGRITY_CHECKS,
  documentStorageMismatches,
  integrityViolations,
  tableCounts,
} from './acceptance-integrity.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { DAYS, handoverServicesFor, pngBytes, scheduledBooking } from './handover-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import {
  collectKeys,
  forbiddenKeysIn,
  portalApp,
  portalGet,
  portalPost,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { issuedBooking, jpegBytes, POINT_MARKER, readyReturn } from './return-helpers.ts';
import {
  adminSession,
  backdateSentNotice,
  drainAllJobs,
  finalizedReturn,
  lineOf,
  openClarifications,
  post,
  sentNoticeMails,
  settlementById,
  settlementRowFor,
} from './settlement-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

let ctx: TestContext;
let portal: PortalTestApp;
let adminId: string;
let cookie: string;
let effective: ReadonlySet<PermissionKey>;

const HOUR = 3_600_000;
/** Maschine der Vermietung A – nach der Rückgabe in Reinigung, dann (per Override) an B. */
const MACHINE_A = 'MR-10-01-01';
/** Dokumentation ohne jeden Betrag (Order §27). */
const DAMAGE_BODY = {
  severity: 'medium' as const,
  description: 'Kratzer am Gehäuse',
  markers: [POINT_MARKER],
};

/** Vermietung A: Rückgabe mit Schaden → Abrechnung → Kundeninformation → Rückmeldung → Transfer. */
const A = {
  bookingId: '',
  processId: '',
  customerId: '',
  returnId: '',
  returnMachineId: '',
  damageId: '',
  settlementId: '',
  clarificationId: '',
  lineId: '',
};
/** Vermietung B: erhält dieselbe Maschine nach A (Adversarial P); ihre Rückgabe bleibt Entwurf. */
const B = { bookingId: '', processId: '', returnId: '', returnMachineId: '' };

beforeAll(async () => {
  ctx = await createTestContext();
  portal = await portalApp(ctx);
  await resetPortalWorld(ctx);
  const session = await adminSession(ctx);
  adminId = session.admin.id;
  cookie = session.cookie;
  effective = session.effective;
});
afterAll(async () => {
  await portal.close();
  await destroyTestContext(ctx);
});

// ── Lokale Hilfen ───────────────────────────────────────────────────────────

async function staffWith(label: string, keys: readonly PermissionKey[]) {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: label,
    lastName: 'Phase18',
    email: `p18.${label.toLowerCase()}@test.example`,
    password: `${label.toLowerCase()}-passwort-12345`,
    permissionKeys: keys,
  });
}

const jpegPhoto = () => ({
  mimeType: 'image/jpeg' as const,
  dataBase64: Buffer.from(jpegBytes()).toString('base64'),
});

const staffGet = (url: string, sessionCookie = cookie) =>
  ctx.app.inject({ method: 'GET', url, headers: { cookie: sessionCookie } });

const staffPost = (url: string, payload: Record<string, unknown>, sessionCookie = cookie) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie: sessionCookie }, payload });

async function count(table: string): Promise<number> {
  const counts = await tableCounts(ctx.pool, [table]);
  return counts[table] ?? 0;
}

async function returnRow(returnId: string) {
  return (await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.id, returnId)))[0]!;
}

async function damageRows(returnId: string) {
  return ctx.db
    .select()
    .from(machineDamages)
    .where(eq(machineDamages.returnId, returnId))
    .orderBy(asc(machineDamages.createdAt));
}

async function protocolDocuments(processId: string) {
  return (await ctx.db.select().from(documents).where(eq(documents.processId, processId))).filter(
    (document) => document.type === 'return_protocol',
  );
}

async function assignmentsOf(bookingId: string) {
  return ctx.db
    .select()
    .from(machineAssignments)
    .where(eq(machineAssignments.bookingId, bookingId))
    .orderBy(asc(machineAssignments.slotNo));
}

async function settlementRow(settlementId: string) {
  return (await ctx.db.select().from(settlements).where(eq(settlements.id, settlementId)))[0]!;
}

async function clarificationsOf(settlementId: string) {
  return ctx.db
    .select()
    .from(settlementClarifications)
    .where(eq(settlementClarifications.settlementId, settlementId))
    .orderBy(asc(settlementClarifications.createdAt));
}

async function damageLines(settlementId: string) {
  return (
    await ctx.db
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, settlementId))
  ).filter((line) => line.type === 'damage_charge');
}

async function transferJobsFor(settlementId: string) {
  return ctx.db
    .select()
    .from(integrationJobs)
    .where(
      and(
        eq(integrationJobs.type, 'settlement.accounting_transfer'),
        sql`${integrationJobs.payload}->>'settlementId' = ${settlementId}`,
      ),
    );
}

async function transfersOf(settlementId: string) {
  return ctx.db
    .select()
    .from(accountingTransfers)
    .where(eq(accountingTransfers.settlementId, settlementId));
}

async function processStatus(processId: string) {
  return (await ctx.db.select().from(processes).where(eq(processes.id, processId)))[0]!.mainStatus;
}

// ── Szenario B – Schaden ────────────────────────────────────────────────────

describe('Phase 18 – Szenario B: Schaden', () => {
  it('P18-B1. Rückgabe mit Schaden: strikter Body (kein Betrag, ≥ 1 Markierung), Pflichtfoto blockiert die Finalisierung, Doppel-Finalisierung idempotent ⇒ Schaden genau einmal aktiv, Maschine in Reinigung, genau eine Abrechnung mit genau einer Klärung', async () => {
    const issued = await issuedBooking(ctx, adminId, { machineCodes: [MACHINE_A] });
    A.bookingId = issued.bookingId;
    A.processId = issued.processId;
    A.customerId = issued.customerId;
    const machine = await machineByCode(ctx.db, MACHINE_A);
    expect(machine.status).toBe('rented');

    // S1 Rückgabe starten (Route) – Entwurf.
    const started = await staffPost(`/staff/returns/${A.bookingId}/start`, {});
    expect(started.statusCode).toBe(200);
    const detail = started.json().detail as {
      return: { id: string; status: string };
      machines: { id: string }[];
    };
    expect(detail.return.status).toBe('draft');
    A.returnId = detail.return.id;
    A.returnMachineId = detail.machines[0]!.id;
    const damageUrl = `/staff/returns/${A.bookingId}/machines/${A.returnMachineId}/damages`;

    // S2 strikter Body: Betrags-/Kostenfelder, fehlende Markierung oder Beschreibung ⇒ 400, keine Zeile.
    for (const payload of [
      { ...DAMAGE_BODY, amountCents: 4500 },
      { ...DAMAGE_BODY, costCents: 4500 },
      { ...DAMAGE_BODY, markers: [] },
      { severity: 'medium', markers: [POINT_MARKER] },
    ]) {
      const rejected = await staffPost(damageUrl, payload);
      expect(rejected.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await count('machine_damages')).toBe(0);

    // Regulärer Entwurf: Rückgabeperson, Zubehör, Sauberkeit, beide Unterschriften …
    const services = handoverServicesFor(ctx);
    await readyReturn(ctx, adminId, services, A.bookingId);
    // … und der Schaden als reine Dokumentation.
    const created = await staffPost(damageUrl, DAMAGE_BODY);
    expect(created.statusCode).toBe(200);
    A.damageId = created.json().damageId as string;
    expect(A.damageId).toMatch(/^[0-9a-f-]{36}$/);
    const draftDamage = (await damageRows(A.returnId))[0]!;
    expect(draftDamage).toMatchObject({
      id: A.damageId,
      origin: 'return',
      machineId: machine.id,
      returnId: A.returnId,
      returnMachineId: A.returnMachineId,
      severity: 'medium',
      requiresFinancialReview: true,
      activatedAt: null,
      resolvedAt: null,
      createdBy: adminId,
      clientMutationId: null,
    });

    // S3 Pflichtfoto: Blocker sichtbar, Finalisierung 409, nichts entsteht.
    let view = await staffGet(`/staff/returns/${A.bookingId}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().detail.blockers).toEqual([
      expect.stringContaining('mindestens ein Foto fehlt'),
    ]);
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${A.bookingId}/finalize`,
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain('Foto');
    expect((await returnRow(A.returnId)).status).toBe('draft');
    expect(await protocolDocuments(A.processId)).toHaveLength(0);
    expect(await count('settlements')).toBe(0);

    const photo = await staffPost(`/staff/damages/${A.damageId}/photos`, jpegPhoto());
    expect(photo.statusCode).toBe(200);
    view = await staffGet(`/staff/returns/${A.bookingId}`);
    expect(view.json().detail.blockers).toEqual([]);

    // S5 Doppelklick auf „Abschließen“: beide 200, genau EIN Aufruf finalisiert (return-finalization 106).
    const finalize = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/staff/returns/${A.bookingId}/finalize`,
        headers: { cookie },
      });
    const [first, second] = await Promise.all([finalize(), finalize()]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const flags = [first.json().detail.finalized, second.json().detail.finalized] as boolean[];
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(first.json().detail.return.finalizedAt).toBe(second.json().detail.return.finalizedAt);

    // Endzustand (Karte B, B4).
    const finalizedRow = await returnRow(A.returnId);
    expect(finalizedRow.status).toBe('finalized');
    expect(finalizedRow.finalizedAt).not.toBeNull();
    expect(finalizedRow.protocolDocumentId).not.toBeNull();
    expect(finalizedRow.returnerPhone).toBeNull();
    const protocols = await protocolDocuments(A.processId);
    expect(protocols).toHaveLength(1);
    expect(protocols[0]!.id).toBe(finalizedRow.protocolDocumentId);
    const activeDamage = (await damageRows(A.returnId))[0]!;
    expect(activeDamage.id).toBe(A.damageId);
    expect(activeDamage.activatedAt?.getTime()).toBe(finalizedRow.finalizedAt!.getTime());
    expect(activeDamage.requiresFinancialReview).toBe(true);
    expect(activeDamage.resolvedAt).toBeNull();
    const cleaning = await machineByCode(ctx.db, MACHINE_A);
    expect(cleaning.status).toBe('cleaning');
    expect(cleaning.cleaningSince).not.toBeNull();
    expect((await assignmentsOf(A.bookingId)).map((a) => a.status)).toEqual(['returned']);

    const settlementRows = await ctx.db
      .select()
      .from(settlements)
      .where(eq(settlements.returnId, A.returnId));
    expect(settlementRows).toHaveLength(1);
    expect(await count('settlements')).toBe(1);
    A.settlementId = settlementRows[0]!.id;
    expect(settlementRows[0]).toMatchObject({
      status: 'clarification_required',
      bookingId: A.bookingId,
      processId: A.processId,
      lockedAt: null,
      noticeRequired: false,
    });
    const damageCost = (await clarificationsOf(A.settlementId)).filter(
      (c) => c.type === 'damage_cost',
    );
    expect(damageCost).toHaveLength(1);
    expect(damageCost[0]).toMatchObject({ sourceId: A.damageId, status: 'open' });
    A.clarificationId = damageCost[0]!.id;
    expect(await damageLines(A.settlementId)).toEqual([]);

    const settlementView = await settlementById(ctx.app, cookie, A.settlementId);
    expect(settlementView.settlement.status).toBe('clarification_required');
    expect(settlementView.dominantAction.key).toBe('resolve_clarifications');
    expect(openClarifications(settlementView, 'damage_cost')[0]).toMatchObject({
      id: A.clarificationId,
      sourceId: A.damageId,
      title: 'Schadenkosten klären',
      context: { machineCode: MACHINE_A, description: 'Kratzer am Gehäuse', photoCount: 1 },
    });
    expect(lineOf(settlementView, 'damage_charge')).toEqual([]);
  });

  it('P18-B2. Kostenentscheid: ohne damage.set_cost 403 ohne Position; zwei Mitarbeiter gleichzeitig ⇒ genau ein 200 und ein 409 VERSION_CONFLICT, genau eine Position 45,00 EUR mit Quelle damage:<id>; Status „Kundeninformation erforderlich“', async () => {
    const url = `/staff/settlements/${A.settlementId}/clarifications/${A.clarificationId}/resolve`;
    let view = await settlementById(ctx.app, cookie, A.settlementId);

    const noRight = await staffWith('Ohnekosten', ['process.view_all', 'settlement.view']);
    const denied = await post(ctx.app, noRight.cookie, url, {
      decision: 'charge',
      amountCents: 4500,
      version: view.settlement.version,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('FORBIDDEN');
    expect(await damageLines(A.settlementId)).toEqual([]);
    expect((await settlementRow(A.settlementId)).version).toBe(view.settlement.version);
    expect(
      (await clarificationsOf(A.settlementId)).find((c) => c.id === A.clarificationId)?.status,
    ).toBe('open');

    const one = await staffWith('Kosteneins', [
      'process.view_all',
      'settlement.view',
      'damage.set_cost',
    ]);
    const two = await staffWith('Kostenzwei', [
      'process.view_all',
      'settlement.view',
      'damage.set_cost',
    ]);
    view = await settlementById(ctx.app, cookie, A.settlementId);
    const decision = { decision: 'charge', amountCents: 4500, version: view.settlement.version };
    const results = await Promise.all([
      post(ctx.app, one.cookie, url, decision),
      post(ctx.app, two.cookie, url, decision),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    // Beide senden dieselbe Version: der Verlierer scheitert deterministisch am Versionsvergleich.
    expect(loser.body.error?.code).toBe('VERSION_CONFLICT');

    const lines = await damageLines(A.settlementId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'damage_charge',
      amountCents: 4500,
      sourceType: 'machine_damage',
      sourceId: A.damageId,
      sourceKey: `damage:${A.damageId}`,
    });
    expect([one.user.id, two.user.id]).toContain(lines[0]!.createdBy);
    A.lineId = lines[0]!.id;
    const row = await settlementRow(A.settlementId);
    expect(row).toMatchObject({
      status: 'customer_notice_required',
      noticeRequired: true,
      noticeSentAt: null,
      waitUntil: null,
      version: view.settlement.version + 1,
    });
    const clarification = (await clarificationsOf(A.settlementId)).find(
      (c) => c.id === A.clarificationId,
    )!;
    expect(clarification).toMatchObject({ status: 'resolved', resolution: 'charged' });
    expect([one.user.id, two.user.id]).toContain(clarification.resolvedBy);
    view = await settlementById(ctx.app, cookie, A.settlementId);
    expect(view.settlement.chargesTotalCents).toBe(4500);
    expect(view.dominantAction.key).toBe('review_notice');
    expect(view.notice).toMatchObject({ status: 'prepared', totalCents: 4500 });
    // Der historische Rückgabefakt bleibt unverändert (kein Betrag am Schaden).
    expect((await damageRows(A.returnId))[0]).toMatchObject({
      id: A.damageId,
      requiresFinancialReview: true,
    });
  });

  it('P18-B3. Schaden A ≠ B (Adversarial P): Maschine noch in Reinigung per Override an Vermietung B ausgegeben ⇒ Nachtrag zum Return A 409 ohne Zeile; fremder Rückgabeabschnitt ⇒ 404 bzw. 409; Klärung hängt nur am Settlement der eigenen Rückgabe', async () => {
    const machine = await machineByCode(ctx.db, MACHINE_A);
    expect(machine.status).toBe('cleaning');
    const services = handoverServicesFor(ctx);
    const next = await scheduledBooking(ctx, adminId, {
      from: new Date(Date.now() + 10 * DAYS),
      to: new Date(Date.now() + 12 * DAYS),
    });
    B.bookingId = next.bookingId;
    B.processId = next.processId;
    await services.handover.ensureForBooking(B.bookingId, adminId);
    const slot = (await services.assignments.slotsForBooking(B.bookingId))[0]!;
    // Reinigung ist ein Override-Grund (kein harter Blocker): Ausgabe nur mit bewusster
    // Bestätigung und Grund (Phase 6 §§7/49) – die Maschine wechselt damit zu Vermietung B.
    const evaluation = await services.assignments.evaluateMachine(
      machine.id,
      await services.assignments.assignmentById(slot.id),
    );
    expect(evaluation.hardBlocked).toBe(false);
    expect(evaluation.overrideRequired).toBe(true);
    expect(evaluation.problems.map((p) => p.code)).toContain('status_cleaning');
    await services.assignments.assign(adminId, effective, slot.id, machine.id, {
      reason: 'Phase-18-Abnahme: Ausgabe an Vermietung B während der Reinigung',
    });
    await services.assignments.prepare(adminId, slot.id);
    await services.handover.setRecipient(B.bookingId, { kind: 'customer' });
    await services.handover.checkMachine(adminId, B.bookingId, slot.id);
    await services.handover.addPhoto(adminId, B.bookingId, slot.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    await services.handover.sign(adminId, B.bookingId, 'customer', pngBytes());
    await services.handover.sign(adminId, B.bookingId, 'staff', pngBytes());
    await services.handover.finalize(adminId, B.bookingId);
    await settleMailJobs(ctx); // Übergabeprotokoll-Mail der Vermietung B abarbeiten
    const issuedToB = await machineByCode(ctx.db, MACHINE_A);
    expect(issuedToB.status).toBe('rented');
    expect(issuedToB.cleaningSince).toBeNull();
    expect((await assignmentsOf(B.bookingId)).map((a) => a.status)).toEqual(['issued']);
    expect((await assignmentsOf(A.bookingId)).map((a) => a.status)).toEqual(['returned']);

    // Nachtrag „zum letzten Rückgabevorgang“ der Maschine: nach der Ausgabe an B ⇒ 409, keine Zeile.
    const damagesBefore = await count('machine_damages');
    const photosBefore = await count('damage_photos');
    const finding = await staffPost(`/staff/machines/${machine.id}/damages`, {
      severity: 'light',
      description: 'Nachtrag nach Ausgabe an B',
      markers: [POINT_MARKER],
      photo: jpegPhoto(),
    });
    expect(finding.statusCode).toBe(409);
    expect(finding.json().error.message).toContain('nicht mehr in Reinigung');
    expect(await count('machine_damages')).toBe(damagesBefore);
    expect(await count('damage_photos')).toBe(photosBefore);
    const condition = await staffGet(`/staff/machines/${machine.id}/condition`);
    expect(condition.statusCode).toBe(200);
    expect(condition.json().postReturnFindingOpen).toBe(false);
    expect(condition.json().currentDamages.map((d: { id: string }) => d.id)).toEqual([A.damageId]);

    // Rückgabe B starten (Entwurf) – ein Rückgabeabschnitt gehört immer zu genau einer Rückgabe.
    const startedB = await staffPost(`/staff/returns/${B.bookingId}/start`, {});
    expect(startedB.statusCode).toBe(200);
    B.returnId = startedB.json().detail.return.id as string;
    B.returnMachineId = startedB.json().detail.machines[0].id as string;
    expect(B.returnMachineId).not.toBe(A.returnMachineId);
    const crossIntoB = await staffPost(
      `/staff/returns/${B.bookingId}/machines/${A.returnMachineId}/damages`,
      DAMAGE_BODY,
    );
    expect(crossIntoB.statusCode).toBe(404); // Abschnitt von A ist für Rückgabe B unbekannt
    const crossIntoA = await staffPost(
      `/staff/returns/${A.bookingId}/machines/${B.returnMachineId}/damages`,
      DAMAGE_BODY,
    );
    expect(crossIntoA.statusCode).toBe(409); // Rückgabe A ist finalisiert und unveränderlich
    expect(await count('machine_damages')).toBe(damagesBefore);

    // Invariante B4: Klärungen nur am Settlement der eigenen Rückgabe; B hat keine Abrechnung.
    const check = INTEGRITY_CHECKS.find(
      (c) => c.name === 'clarification_for_damage_of_other_return',
    )!;
    expect((await ctx.pool.query(check.sql)).rows).toEqual([]);
    expect((await settlementRow(A.settlementId)).returnId).toBe(A.returnId);
    expect(
      (await clarificationsOf(A.settlementId))
        .filter((c) => c.type === 'damage_cost')
        .map((c) => c.sourceId),
    ).toEqual([A.damageId]);
    expect(
      await ctx.db.select().from(settlements).where(eq(settlements.bookingId, B.bookingId)),
    ).toEqual([]);
    expect(await count('settlements')).toBe(1);
  });

  it('P18-B4. Ohne damage.document ⇒ 403 FORBIDDEN für Entwurfsschaden und Schadensfoto – keine Dokumentationszeile, kein Foto', async () => {
    const noRight = await staffWith('Ohnedoku', [
      'process.view_all',
      'return.view',
      'return.perform',
    ]);
    const damagesBefore = await count('machine_damages');
    const photosBefore = await count('damage_photos');
    const denied = await staffPost(
      `/staff/returns/${B.bookingId}/machines/${B.returnMachineId}/damages`,
      DAMAGE_BODY,
      noRight.cookie,
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    const photoDenied = await staffPost(
      `/staff/damages/${A.damageId}/photos`,
      jpegPhoto(),
      noRight.cookie,
    );
    expect(photoDenied.statusCode).toBe(403);
    expect(await count('machine_damages')).toBe(damagesBefore);
    expect(await count('damage_photos')).toBe(photosBefore);
    expect(await damageRows(B.returnId)).toEqual([]);
  });

  it('P18-B5. Portal während offener Klärung: Rechnung „wird vorbereitet“, Rückgabeprotokoll sichtbar, keine Klärungen/Positionen/Beträge/Schäden im DTO', async () => {
    const session = await portalSessionFor(ctx, A.customerId);
    const list = await portalGet(portal.app, session.cookie, '/portal/bookings');
    expect(list.status).toBe(200);
    const bookings = (list.body as { bookings: { bookingId: string; portalState: string }[] })
      .bookings;
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ bookingId: A.bookingId, portalState: 'active' });

    const detail = await portalGet(portal.app, session.cookie, `/portal/bookings/${A.bookingId}`);
    expect(detail.status).toBe(200);
    const view = detail.body as PortalBookingView;
    expect(view.portalState).toBe('active');
    expect(view.invoice).toEqual({
      status: 'preparing',
      label: 'Rechnung wird vorbereitet',
      finalAmountCents: null,
    });
    expect(view.cancellation).toBeNull();
    expect(forbiddenKeysIn(view)).toEqual([]);
    const keys = [...collectKeys(view)];
    for (const key of ['clarifications', 'lines', 'amountCents', 'damage', 'damages']) {
      expect(keys).not.toContain(key);
    }
    expect(keys.some((key) => /damage|clarification|settlement|notice|charge/i.test(key))).toBe(
      false,
    );
    expect(JSON.stringify(view)).not.toMatch(/Kratzer am Gehäuse|damage_charge|\b4500\b/);

    const docs = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${A.bookingId}/documents`,
    );
    expect(docs.status).toBe(200);
    const types = (docs.body as { documents: PortalDocumentView[] }).documents.map((d) => d.type);
    expect(types).toContain('return_protocol');
    expect(forbiddenKeysIn(docs.body)).toEqual([]);
  });

  it('P18-B6. Online-Doppel-Submit eines Entwurfsschadens mit identischem Body OHNE clientMutationId (API-Clients) ⇒ zwei Dokumentationszeilen; mit Schlüssel genau eine (acceptance-fixes P18-F2a)', async () => {
    const url = `/staff/returns/${B.bookingId}/machines/${B.returnMachineId}/damages`;
    const payload = {
      severity: 'light' as const,
      description: 'Doppelt gesendeter Kratzer',
      markers: [POINT_MARKER],
    };
    const [first, second] = await Promise.all([staffPost(url, payload), staffPost(url, payload)]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const rows = await damageRows(B.returnId);
    // Beobachtung (Karte B): ohne clientMutationId zwei Dokumentationszeilen – Phase 18 ergänzte den
    // optionalen Schlüssel (Staff-App sendet ihn immer); der Replay-Pfad ist in acceptance-fixes P18-F2a belegt.
    expect(rows).toHaveLength(2);
    expect(new Set([first.json().damageId, second.json().damageId]).size).toBe(2);
    expect(rows.map((r) => r.id).sort()).toEqual(
      [first.json().damageId as string, second.json().damageId as string].sort(),
    );
    expect(
      rows.every(
        (r) =>
          r.clientMutationId === null &&
          r.activatedAt === null &&
          r.origin === 'return' &&
          r.returnMachineId === B.returnMachineId &&
          r.description === payload.description,
      ),
    ).toBe(true);
    // Zwischenstand nach Szenario B: systemweite Invarianten ohne Befund.
    expect(await integrityViolations(ctx.pool)).toEqual([]);
  });
});

// ── Szenario C – Kundeneinspruch/Widerspruch ────────────────────────────────

describe('Phase 18 – Szenario C: Kundeneinspruch/Widerspruch (Kundenrückmeldung zur Vorinformation)', () => {
  it('P18-C1. Kundeninformation: vorbereitet ohne Fristtext; Freigabe reiht nur ein, erst der bestätigte Versand startet die 24-h-Frist und plant den Auto-Job zum Fristende; zweite Freigabe 409 NOTICE_ALREADY_SENT, genau eine Mail', async () => {
    const notice = await staffGet(`/staff/settlements/${A.settlementId}/notice`);
    expect(notice.statusCode).toBe(200);
    const prepared = notice.json() as NoticeView;
    expect(prepared.status).toBe('prepared');
    expect(prepared.positions).toEqual([
      expect.objectContaining({ type: 'damage_charge', amountCents: 4500, lineId: A.lineId }),
    ]);
    expect(prepared.totalCents).toBe(4500);
    expect(prepared.recipientEmail).toBe('klara.kommerz@test.example');
    expect(prepared.bodyText).toContain('Kratzer am Gehäuse');
    // Phase 19 (P19-F8): Vorschau = Mailvorlage – Betrag im Mailformat „45,00 €“ (geschütztes Leerzeichen).
    expect(prepared.bodyText).toMatch(/45,00\s€/);
    expect(prepared.bodyText).toContain('Rückgabeprotokoll');
    // Keine Frist, kein Countdown, keine Drohformulierung gegenüber dem Kunden (Phase 9 §25).
    expect(prepared.bodyText).not.toMatch(
      /24 ?Stunden|Frist|innerhalb|binnen|automatisch|Widerspruch|Mahnung|rechtliche Schritte/i,
    );
    expect(prepared.sentAt).toBeNull();
    expect(await sentNoticeMails(ctx)).toHaveLength(0);
    expect(await transferJobsFor(A.settlementId)).toHaveLength(0);

    let view = await settlementById(ctx.app, cookie, A.settlementId);
    const approved = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${A.settlementId}/notice/approve-and-send`,
      { version: view.settlement.version },
    );
    expect(approved.status).toBe(200);
    // Freigabe = Einreihen in die Outbox: die Frist läuft noch NICHT.
    expect((approved.body as unknown as SettlementView).notice).toMatchObject({ status: 'queued' });
    let row = await settlementRow(A.settlementId);
    expect(row.noticeSentAt).toBeNull();
    expect(row.waitUntil).toBeNull();
    expect(row.status).toBe('customer_notice_required');
    const noticeRows = await ctx.db
      .select()
      .from(settlementCustomerNotices)
      .where(eq(settlementCustomerNotices.settlementId, A.settlementId));
    expect(noticeRows).toHaveLength(1);
    expect(noticeRows[0]).toMatchObject({ status: 'queued', approvedBy: adminId });
    expect(noticeRows[0]!.approvedAt).not.toBeNull();

    // Bestätigter Mailversand (FakeMailGateway) ⇒ Frist beginnt, Auto-Job zum Fristende.
    expect(await drainAllJobs(ctx)).toBeGreaterThan(0);
    const mails = await sentNoticeMails(ctx);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      recipientEmail: 'klara.kommerz@test.example',
      bookingId: A.bookingId,
    });
    row = await settlementRow(A.settlementId);
    expect(row.noticeSentAt).not.toBeNull();
    expect(row.waitUntil!.getTime() - row.noticeSentAt!.getTime()).toBe(24 * HOUR);
    expect(row.status).toBe('customer_waiting');
    expect(row.manualTransferRequired).toBe(false);
    expect(row.customerResponseReceivedAt).toBeNull();
    const jobs = await transferJobsFor(A.settlementId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('pending');
    expect(jobs[0]!.runAt.getTime()).toBe(row.waitUntil!.getTime());
    expect((jobs[0]!.payload as { reason?: string }).reason).toBe('auto');
    expect(
      (await clarificationsOf(A.settlementId)).find((c) => c.type === 'customer_notice'),
    ).toMatchObject({ status: 'resolved', resolution: 'sent' });
    view = await settlementById(ctx.app, cookie, A.settlementId);
    expect(view.settlement.status).toBe('customer_waiting');
    expect(view.settlement.statusLabel).toBe('Kundenrückmeldung abwarten');
    expect(view.dominantAction.key).toBe('wait');
    expect(view.settlement.autoTransferPlannedAt).toBe(view.settlement.waitUntil);
    expect(view.notice).toMatchObject({ status: 'sent', gateway: 'mail' });

    // Nur einmal je Abrechnung (§28).
    const again = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${A.settlementId}/notice/approve-and-send`,
      { version: view.settlement.version },
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('NOTICE_ALREADY_SENT');
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
    expect(await transferJobsFor(A.settlementId)).toHaveLength(1);
    expect((await settlementRow(A.settlementId)).noticeSentAt?.getTime()).toBe(
      row.noticeSentAt!.getTime(),
    );
  });

  it('P18-C2. Portalnachricht des Kunden ist KEINE Kundenrückmeldung: Abrechnung (Rückmeldung, Version, Status, updated_at) unverändert, keine Klärung, Auto-Job unverändert geplant', async () => {
    const before = await settlementRow(A.settlementId);
    expect(before.noticeSentAt).not.toBeNull();
    expect(before.customerResponseReceivedAt).toBeNull();
    const session = await portalSessionFor(ctx, A.customerId);
    const message = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${A.bookingId}/messages`,
      { body: 'Den Kratzer gab es schon bei der Abholung – ich widerspreche der Belastung.' },
    );
    expect(message.status).toBe(201);
    await drainAllJobs(ctx); // Push an Zuständige – nie eine Abrechnungsaktion
    const after = await settlementRow(A.settlementId);
    expect(after).toEqual(before);
    expect(
      (await clarificationsOf(A.settlementId)).filter((c) => c.type === 'customer_response'),
    ).toEqual([]);
    const messages = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${A.bookingId}/messages`,
    );
    expect(messages.status).toBe(200);
    expect((messages.body as { messages: unknown[] }).messages).toHaveLength(1);
    const jobs = await transferJobsFor(A.settlementId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'pending' });
    expect(jobs[0]!.runAt.getTime()).toBe(before.waitUntil!.getTime());
  });

  it('P18-C3. Zwei Mitarbeiter erfassen die Kundenrückmeldung gleichzeitig ⇒ genau ein 200 und ein 409; genau eine offene Klärung, nur manueller Transfer; der fällige Auto-Job überspringt (kein Transfer); Neuladen verändert die Rückmeldung nicht', async () => {
    const one = await staffWith('Freigabeeins', [
      'process.view_all',
      'settlement.view',
      'settlement.release',
    ]);
    const two = await staffWith('Freigabezwei', [
      'process.view_all',
      'settlement.view',
      'settlement.release',
    ]);
    const view = await settlementById(ctx.app, cookie, A.settlementId);
    expect(view.settlement.status).toBe('customer_waiting');
    const url = `/staff/settlements/${A.settlementId}/customer-response`;
    const results = await Promise.all([
      post(ctx.app, one.cookie, url, { version: view.settlement.version }),
      post(ctx.app, two.cookie, url, { version: view.settlement.version }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(['VERSION_CONFLICT', 'CUSTOMER_RESPONSE_ALREADY_RECORDED']).toContain(
      loser.body.error?.code,
    );

    let row = await settlementRow(A.settlementId);
    expect(row.customerResponseReceivedAt).not.toBeNull();
    expect(row.manualTransferRequired).toBe(true);
    expect(row.status).toBe('clarification_required');
    expect(row.version).toBe(view.settlement.version + 1);
    const responses = (await clarificationsOf(A.settlementId)).filter(
      (c) => c.type === 'customer_response',
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ status: 'open', sourceId: A.settlementId });
    const current = await settlementById(ctx.app, cookie, A.settlementId);
    expect(current.dominantAction).toMatchObject({
      key: 'release_as_calculated',
      label: 'Wie berechnet freigeben',
    });
    expect(current.settlement.autoTransferPlannedAt).toBeNull();

    // Frist abgelaufen (SQL-Backdating wie settlement-notice-wait) ⇒ fälliger Auto-Job überspringt.
    await backdateSentNotice(ctx, A.settlementId, new Date(Date.now() - 25 * HOUR));
    const due = await transferJobsFor(A.settlementId);
    expect(due).toHaveLength(1);
    expect(due[0]!.status).toBe('pending');
    expect(due[0]!.runAt.getTime()).toBeLessThan(Date.now());
    await drainAllJobs(ctx);
    const afterJob = await transferJobsFor(A.settlementId);
    expect(afterJob).toHaveLength(1);
    expect(afterJob[0]!.status).toBe('succeeded'); // Handler lief – Ergebnis „skipped“, nichts übertragen
    expect(await transfersOf(A.settlementId)).toEqual([]);
    expect(ctx.accounting.calls).toHaveLength(0);
    row = await settlementRow(A.settlementId);
    expect(row.status).toBe('clarification_required');
    expect(row.customerResponseReceivedAt).not.toBeNull();
    expect(row.lockedAt).toBeNull();
    expect(row.accountingTransferId).toBeNull();

    // Neuladen (GET = refresh/rebuild) verändert die Rückmeldung nicht.
    const before = await settlementRow(A.settlementId);
    const reload = await staffGet(`/staff/settlements/${A.settlementId}`);
    expect(reload.statusCode).toBe(200);
    const after = await settlementRow(A.settlementId);
    // refresh schreibt nur den technischen Zeitstempel updated_at neu – alle Fachfelder sind identisch.
    const { updatedAt: _beforeUpdatedAt, ...beforeFields } = before;
    const { updatedAt: _afterUpdatedAt, ...afterFields } = after;
    expect(afterFields).toEqual(beforeFields);
    expect(
      (await clarificationsOf(A.settlementId))
        .filter((c) => c.type === 'customer_response')
        .map((c) => ({ id: c.id, status: c.status, resolution: c.resolution })),
    ).toEqual(responses.map((c) => ({ id: c.id, status: c.status, resolution: c.resolution })));
    expect(await processStatus(A.processId)).toBe('open');
  });

  it('P18-C4. „Wie berechnet freigeben“ ⇒ Rückmeldung erledigt (released_as_charged), nur manueller Transfer: Auto-Job überträgt nicht, end-wait 409 NOT_WAITING; manueller Transfer genau einmal ⇒ gesperrt, Vorgang abgeschlossen; danach jede Änderung 409 SETTLEMENT_LOCKED', async () => {
    let view = await settlementById(ctx.app, cookie, A.settlementId);
    const released = await post(ctx.app, cookie, `/staff/settlements/${A.settlementId}/release`, {
      version: view.settlement.version,
    });
    expect(released.status).toBe(200);
    let row = await settlementRow(A.settlementId);
    expect(row.releasedAt).not.toBeNull();
    expect(row.releasedBy).toBe(adminId);
    expect(row.manualTransferRequired).toBe(true);
    expect(row.status).toBe('ready_for_accounting');
    expect(row.customerResponseReceivedAt).not.toBeNull(); // Historie bleibt
    const response = (await clarificationsOf(A.settlementId)).find(
      (c) => c.type === 'customer_response',
    )!;
    expect(response).toMatchObject({
      status: 'resolved',
      resolution: 'released_as_charged',
      resolvedBy: adminId,
    });
    view = await settlementById(ctx.app, cookie, A.settlementId);
    expect(view.dominantAction).toMatchObject({
      key: 'transfer_now',
      label: 'Jetzt an Buchhaltung übertragen',
    });
    expect(view.settlement.autoTransferPlannedAt).toBeNull();
    // Kein Auto-Transfer trotz „bereit“: Jobs laufen leer, keine Transferzeile, kein Gateway-Aufruf.
    await drainAllJobs(ctx);
    expect(await transfersOf(A.settlementId)).toEqual([]);
    expect(ctx.accounting.calls).toHaveLength(0);
    expect((await settlementRow(A.settlementId)).status).toBe('ready_for_accounting');
    // „Jetzt freigeben“ außerhalb des Wartefensters ⇒ 409 NOT_WAITING.
    const notWaiting = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${A.settlementId}/end-wait`,
      { version: view.settlement.version },
    );
    expect(notWaiting.status).toBe(409);
    expect(notWaiting.body.error?.code).toBe('NOT_WAITING');

    // Manueller Transfer (Admin) genau einmal.
    view = await settlementById(ctx.app, cookie, A.settlementId);
    const transfer = await post(ctx.app, cookie, `/staff/settlements/${A.settlementId}/transfer`, {
      version: view.settlement.version,
    });
    expect(transfer.status).toBe(200);
    expect(transfer.body.outcome).toBe('succeeded');
    const transfers = await transfersOf(A.settlementId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ status: 'succeeded', kind: 'settlement' });
    expect(transfers[0]!.externalReference).toMatch(/^MOCK-RE-/);
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.accounting.calls[0]!.amountDueCents).toBe(view.settlement.amountDueCents);
    expect(view.settlement.amountDueCents).toBe(7500 + 4500); // Miete 1×10 + Schadenkosten
    row = await settlementRow(A.settlementId);
    expect(row).toMatchObject({ status: 'transferred', accountingTransferId: transfers[0]!.id });
    expect(row.lockedAt).not.toBeNull();
    expect(row.transferredAt).not.toBeNull();
    expect(await processStatus(A.processId)).toBe('completed');
    await drainAllJobs(ctx); // Foto-Retention-Job des Abschlusses – kein zweiter Transfer
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(await transfersOf(A.settlementId)).toHaveLength(1);

    // Gesperrt: Rückmeldung, Wartefenster, Positionsänderung ⇒ 409 SETTLEMENT_LOCKED.
    view = await settlementById(ctx.app, cookie, A.settlementId);
    expect(view.settlement.locked).toBe(true);
    const version = view.settlement.version;
    const attempts = [
      () =>
        post(ctx.app, cookie, `/staff/settlements/${A.settlementId}/customer-response`, {
          version,
        }),
      () => post(ctx.app, cookie, `/staff/settlements/${A.settlementId}/end-wait`, { version }),
      () =>
        post(
          ctx.app,
          cookie,
          `/staff/settlements/${A.settlementId}/lines/${A.lineId}`,
          { amountCents: 1, version },
          'PATCH',
        ),
    ];
    for (const attempt of attempts) {
      const result = await attempt();
      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe('SETTLEMENT_LOCKED');
    }
    expect((await damageLines(A.settlementId))[0]!.amountCents).toBe(4500);
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
    expect((await settlementRow(A.settlementId)).version).toBe(version);
  });

  it('P18-C5. Rechte-Negativmatrix an einer frischen Abrechnung im Wartefenster: ohne settlement.release (approve-and-send, customer-response, release), ohne settlement.end_pre_notice_wait (end-wait), ohne lexware.manual_transfer (transfer) ⇒ 403 ohne jede Nebenwirkung', async () => {
    const world = await finalizedReturn(ctx, adminId, cookie, {
      machineCodes: ['MR-10-01-02'],
      damages: [{ description: 'Delle am Deckel', severity: 'light' }],
    });
    const fresh = (await settlementRowFor(ctx, world.processId))!;
    let view = await settlementById(ctx.app, cookie, fresh.id);
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const decided = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${fresh.id}/clarifications/${clarification.id}/resolve`,
      { decision: 'charge', amountCents: 3000, version: view.settlement.version },
    );
    expect(decided.status).toBe(200);
    view = await settlementById(ctx.app, cookie, fresh.id);
    const sent = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${fresh.id}/notice/approve-and-send`,
      { version: view.settlement.version },
    );
    expect(sent.status).toBe(200);
    await drainAllJobs(ctx);
    const before = await settlementRow(fresh.id);
    expect(before.status).toBe('customer_waiting');
    const tables = [
      'mail_deliveries',
      'integration_jobs',
      'accounting_transfers',
      'settlement_clarifications',
      'settlement_lines',
      'settlement_customer_notices',
    ];
    const countsBefore = await tableCounts(ctx.pool, tables);
    const callsBefore = ctx.accounting.calls.length;
    const mailsBefore = ctx.mailGateway.sent.length;

    const viewer = await staffWith('Nursicht', ['process.view_all', 'settlement.view']);
    const releaser = await staffWith('Nurfreigabe', [
      'process.view_all',
      'settlement.view',
      'settlement.release',
    ]);
    const attempts: { label: string; cookie: string; url: string }[] = [
      {
        label: 'approve-and-send ohne settlement.release',
        cookie: viewer.cookie,
        url: `/staff/settlements/${fresh.id}/notice/approve-and-send`,
      },
      {
        label: 'customer-response ohne settlement.release',
        cookie: viewer.cookie,
        url: `/staff/settlements/${fresh.id}/customer-response`,
      },
      {
        label: 'release ohne settlement.release',
        cookie: viewer.cookie,
        url: `/staff/settlements/${fresh.id}/release`,
      },
      {
        label: 'end-wait ohne settlement.end_pre_notice_wait',
        cookie: releaser.cookie,
        url: `/staff/settlements/${fresh.id}/end-wait`,
      },
      {
        label: 'transfer ohne lexware.manual_transfer',
        cookie: releaser.cookie,
        url: `/staff/settlements/${fresh.id}/transfer`,
      },
    ];
    for (const attempt of attempts) {
      const result = await post(ctx.app, attempt.cookie, attempt.url, { version: before.version });
      expect(result.status, attempt.label).toBe(403);
      expect(result.body.error?.code, attempt.label).toBe('FORBIDDEN');
    }
    expect(await settlementRow(fresh.id)).toEqual(before);
    expect(await tableCounts(ctx.pool, tables)).toEqual(countsBefore);
    expect(ctx.accounting.calls).toHaveLength(callsBefore);
    expect(ctx.mailGateway.sent).toHaveLength(mailsBefore);
    expect(await transfersOf(fresh.id)).toEqual([]);
    expect(await processStatus(world.processId)).toBe('open');

    // Positivkontrolle: dieselbe Route mit dem Recht ⇒ 200 (das Recht ist der einzige Unterschied).
    const recorded = await post(
      ctx.app,
      releaser.cookie,
      `/staff/settlements/${fresh.id}/customer-response`,
      { version: before.version },
    );
    expect(recorded.status).toBe(200);
    const after = await settlementRow(fresh.id);
    expect(after.customerResponseReceivedAt).not.toBeNull();
    expect(after.status).toBe('clarification_required');
    expect(after.version).toBe(before.version + 1);
  });

  it('P18-C6. Integrität nach Szenario B/C: alle SQL-Invarianten und der Dokument-Storage-Abgleich ohne Befund', async () => {
    expect(await integrityViolations(ctx.pool)).toEqual([]);
    expect(await documentStorageMismatches(ctx.pool, ctx.storage)).toEqual([]);
    const counts = await tableCounts(ctx.pool, [
      'settlements',
      'rental_returns',
      'machine_damages',
      'accounting_transfers',
      'cancellations',
    ]);
    // A (abgerechnet) + frische Abrechnung aus C5; Rückgaben A, B (Entwurf), C5;
    // Schäden: A 1, B 2 (Doppel-Submit), C5 1; genau ein Transfer (A); kein Storno.
    expect(counts).toEqual({
      settlements: 2,
      rental_returns: 3,
      machine_damages: 4,
      accounting_transfers: 1,
      cancellations: 0,
    });
  });
});
