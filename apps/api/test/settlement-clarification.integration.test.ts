/**
 * Phase-9-Pflichttests §88 (15–25) und §89 (27–32): Schaden-/Fehlteil-
 * Klärungen (kein automatischer Betrag, Entscheid nur mit Recht, „nicht
 * berechnen“, editierbar vor / gesperrt nach Transfer, erledigter Fehlteil
 * ohne Kostenblocker, historische Rückgabefakten unverändert) sowie
 * manuelle Verspätungsgebühr/Nachbelastung; Concurrency §82 (gleichzeitige
 * Schadenkosten).
 */
import { machineDamages, settlementLines } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { pngBytes } from './handover-helpers.ts';
import { jpegBytes, POINT_MARKER, readyReturn } from './return-helpers.ts';
import {
  adminSession,
  issuedBookingWithOptions,
  lineOf,
  openClarifications,
  post,
  resetSettlementWorld,
  settledReturn,
  settlementById,
  settlementViewFor,
} from './settlement-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetSettlementWorld(ctx);
});

const DAMAGE = { description: 'Kratzer am Gehäuse', severity: 'medium' as const };

describe('Schäden (§88)', () => {
  it('15./16. Dokumentierter Schaden ⇒ offener Klärungspunkt ohne Betrag, kein damage_charge, Status Klärung erforderlich', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { damages: [DAMAGE] });
    const open = openClarifications(view, 'damage_cost');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      sourceId: world.damageIds[0],
      title: 'Schadenkosten klären',
      context: {
        machineCode: 'MR-10-01-01',
        severity: 'medium',
        description: 'Kratzer am Gehäuse',
        photoCount: 1,
      },
    });
    expect(lineOf(view, 'damage_charge')).toEqual([]);
    expect(view.settlement.status).toBe('clarification_required');
    expect(view.settlement.statusLabel).toBe('Klärung erforderlich');
    expect(view.settlement.amountDueCents).toBe(7500);
    expect(view.dominantAction.key).toBe('resolve_clarifications');
    // Transfer solange blockiert (§22).
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      {
        version: view.settlement.version,
      },
    );
    expect(transfer.status).toBe(409);
    expect(transfer.body.error?.code).toBe('TRANSFER_NOT_READY');
    expect(ctx.accounting.calls).toHaveLength(0);
  });

  it('17. Schadenbetrag nur mit damage.set_cost; mit Recht entsteht die Position mit Referenz, Beschreibung und Mitarbeiter', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { damages: [DAMAGE] });
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Kostenrecht',
      email: 'ohne.kosten@test.example',
      password: 'ohne-kosten-passwort-1',
      permissionKeys: ['process.view_all', 'settlement.view', 'settlement.add_manual_charge'],
    });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const url = `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`;
    const denied = await post(ctx.app, limited.cookie, url, {
      decision: 'charge',
      amountCents: 5000,
      version: view.settlement.version,
    });
    expect(denied.status).toBe(403);
    const ok = await post(ctx.app, cookie, url, {
      decision: 'charge',
      amountCents: 5000,
      version: view.settlement.version,
    });
    expect(ok.status).toBe(200);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    const line = lineOf(after, 'damage_charge');
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({
      amountCents: 5000,
      sourceType: 'machine_damage',
      sourceId: world.damageIds[0],
      direction: 'charge',
    });
    expect(line[0]!.description).toContain('Kratzer am Gehäuse');
    expect(openClarifications(after, 'damage_cost')).toEqual([]);
    expect(after.clarifications[0]).toMatchObject({ status: 'resolved', resolution: 'charged' });
    expect(after.settlement.chargesTotalCents).toBe(5000);
    expect(after.settlement.amountDueCents).toBe(12500);
    expect(after.settlement.noticeRequired).toBe(true);
    const stored = await ctx.db
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.id, line[0]!.id));
    expect(stored[0]!.createdBy).toBe(admin.id);
  });

  it('18. „Nicht berechnen“ ⇒ keine Position, Klärung erledigt, Fakt bleibt, Abrechnung bereit', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { damages: [DAMAGE] });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const ok = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      { decision: 'no_charge', version: view.settlement.version },
    );
    expect(ok.status).toBe(200);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'damage_charge')).toEqual([]);
    expect(after.clarifications[0]).toMatchObject({
      status: 'resolved',
      resolution: 'not_charged',
    });
    expect(after.settlement.status).toBe('ready_for_accounting');
    expect(after.settlement.noticeRequired).toBe(false);
    const damage = await ctx.db
      .select()
      .from(machineDamages)
      .where(eq(machineDamages.id, world.damageIds[0]!));
    expect(damage).toHaveLength(1);
    expect(damage[0]!.description).toBe('Kratzer am Gehäuse');
  });

  it('19./20. Schadenkosten vor Transfer editierbar (damage.edit_cost_before_lexware), nach Transfer gesperrt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { damages: [DAMAGE] });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      { decision: 'charge', amountCents: 5000, version: view.settlement.version },
    );
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    const line = lineOf(current, 'damage_charge')[0]!;
    const editor = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Kosten',
      lastName: 'Editor',
      email: 'kosten.editor@test.example',
      password: 'kosten-editor-passwort-1',
      permissionKeys: ['process.view_all', 'settlement.view', 'damage.edit_cost_before_lexware'],
    });
    const noRight = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nur',
      lastName: 'Nachbelastung',
      email: 'nur.nachbelastung@test.example',
      password: 'nur-nachbelastung-passwort-1',
      permissionKeys: ['process.view_all', 'settlement.view', 'settlement.add_manual_charge'],
    });
    const denied = await post(
      ctx.app,
      noRight.cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { amountCents: 4000, version: current.settlement.version },
      'PATCH',
    );
    expect(denied.status).toBe(403);
    const edited = await post(
      ctx.app,
      editor.cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { amountCents: 4000, version: current.settlement.version },
      'PATCH',
    );
    expect(edited.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(current, 'damage_charge')[0]!.amountCents).toBe(4000);
    // Kundeninformation senden, Frist vorzeitig beenden, manuell übertragen ⇒ gesperrt.
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/notice/approve-and-send`,
      {
        version: current.settlement.version,
      },
    );
    await settleMailJobs(ctx); // Phase 12: Frist beginnt erst nach bestätigtem Mailversand
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    await post(ctx.app, cookie, `/staff/settlements/${current.settlement.id}/end-wait`, {
      version: current.settlement.version,
    });
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      {
        version: current.settlement.version,
      },
    );
    expect(transfer.status).toBe(200);
    expect(transfer.body.outcome).toBe('succeeded');
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.locked).toBe(true);
    const locked = await post(
      ctx.app,
      editor.cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { amountCents: 1, version: current.settlement.version },
      'PATCH',
    );
    expect(locked.status).toBe(409);
    expect(locked.body.error?.code).toBe('SETTLEMENT_LOCKED');
    const removed = await post(
      ctx.app,
      editor.cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { version: current.settlement.version },
      'DELETE',
    );
    expect(removed.status).toBe(409);
    expect(
      lineOf(await settlementViewFor(ctx.app, cookie, world.processId), 'damage_charge')[0]!
        .amountCents,
    ).toBe(4000);
  });

  it('15b. Kriterium ist allein requiresFinancialReview: ein in Phase 7 als „nicht mehr aktuell“ markierter Schaden erzeugt trotzdem die Klärung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await issuedBookingWithOptions(ctx, admin.id);
    const { services } = world;
    await services.returns.start(admin.id, world.bookingId);
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipSignatures: true });
    const detail = await services.returns.detail(world.bookingId);
    const { damageId } = await services.returns.addDamage(
      admin.id,
      world.bookingId,
      detail.machines[0]!.id,
      { severity: 'light', description: 'Kratzer, später repariert', markers: [POINT_MARKER] },
    );
    await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    await services.returns.sign(admin.id, world.bookingId, 'customer', pngBytes());
    await services.returns.sign(admin.id, world.bookingId, 'staff', pngBytes());
    // Finalisierung über den Service (ohne Hook) – Schaden VOR dem ensure „nicht mehr aktuell“.
    await services.returns.finalize(admin.id, world.bookingId);
    await services.damages.resolveCurrent(admin.id, damageId);
    const ensure = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/settlement/ensure`,
      headers: { cookie },
    });
    expect(ensure.statusCode).toBe(200);
    const view = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(openClarifications(view, 'damage_cost').map((c) => c.sourceId)).toEqual([damageId]);
    expect(view.settlement.status).toBe('clarification_required');
  });

  it('18b. Kostenentscheid vor Transfer revidierbar: „nicht berechnen“ → „berechnen“ erzeugt die Position; nach Vorbereitung 409', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { damages: [DAMAGE] });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const url = `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`;
    await post(ctx.app, cookie, url, { decision: 'no_charge', version: view.settlement.version });
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('ready_for_accounting');
    const revised = await post(ctx.app, cookie, url, {
      decision: 'charge',
      amountCents: 3000,
      version: current.settlement.version,
    });
    expect(revised.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(current, 'damage_charge')).toHaveLength(1);
    expect(lineOf(current, 'damage_charge')[0]!.amountCents).toBe(3000);
    expect(current.clarifications[0]).toMatchObject({ status: 'resolved', resolution: 'charged' });
    expect(current.settlement.status).toBe('customer_notice_required');
    // Bereits „berechnet“ ⇒ erneuter Entscheid 409; Entfernen über die Position.
    const again = await post(ctx.app, cookie, url, {
      decision: 'charge',
      amountCents: 1,
      version: current.settlement.version,
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('CLARIFICATION_RESOLVED');
    const noCharge = await post(ctx.app, cookie, url, {
      decision: 'no_charge',
      version: current.settlement.version,
    });
    expect(noCharge.status).toBe(409);
    // Nach Transfervorbereitung (Fehlschlag) gesperrt.
    const line = lineOf(current, 'damage_charge')[0]!;
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { version: current.settlement.version },
      'DELETE',
    );
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    // Ohne anstehenden Queue-Retry (Auto-Job tot) lautet der Hinweis „bitte manuell erneut übertragen“.
    await ctx.pool.query(`UPDATE integration_jobs SET status = 'dead' WHERE status = 'pending'`);
    ctx.accounting.failNext(1);
    const failed = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(failed.body.outcome).toBe('failed');
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.statusLabel).toBe(
      'Übertragung an Buchhaltung fehlgeschlagen – bitte manuell erneut übertragen.',
    );
    const locked = await post(ctx.app, cookie, url, {
      decision: 'charge',
      amountCents: 3000,
      version: current.settlement.version,
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error?.code).toBe('TRANSFER_PREPARED');
  });

  it('25. Der Kostenentscheid mutiert den historischen Rückgabefakt nicht (machine_damages unverändert)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { damages: [DAMAGE] });
    const before = (
      await ctx.db.select().from(machineDamages).where(eq(machineDamages.id, world.damageIds[0]!))
    )[0]!;
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      { decision: 'charge', amountCents: 12345, version: view.settlement.version },
    );
    const after = (
      await ctx.db.select().from(machineDamages).where(eq(machineDamages.id, world.damageIds[0]!))
    )[0]!;
    expect(after).toEqual(before);
    expect(Object.keys(after)).not.toContain('amountCents');
  });

  it('§82 Concurrency: zwei Mitarbeiter setzen gleichzeitig Schadenkosten ⇒ genau eine Position, ein 409', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { damages: [DAMAGE] });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const url = `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`;
    const results = await Promise.all([
      post(ctx.app, cookie, url, {
        decision: 'charge',
        amountCents: 5000,
        version: view.settlement.version,
      }),
      post(ctx.app, cookie, url, {
        decision: 'charge',
        amountCents: 9000,
        version: view.settlement.version,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'damage_charge')).toHaveLength(1);
    expect([5000, 9000]).toContain(lineOf(after, 'damage_charge')[0]!.amountCents);
  });
});

describe('Fehlteile (§88)', () => {
  it('21./23. Offenes Fehlteil ⇒ Klärung „Ersatzkosten Fehlteil klären“; Betrag nur mit missing_item.set_cost', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      missing: [{ accessoryType: 'lid', quantity: 1 }],
    });
    const open = openClarifications(view, 'missing_item_cost');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      sourceId: world.missingCaseIds[0],
      title: 'Ersatzkosten Fehlteil klären',
      context: {
        machineCode: 'MR-10-01-01',
        accessoryType: 'lid',
        missingQuantity: 1,
        caseStatus: 'open',
      },
    });
    expect(view.settlement.status).toBe('clarification_required');
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nur',
      lastName: 'Schaden',
      email: 'nur.schaden@test.example',
      password: 'nur-schaden-passwort-1',
      permissionKeys: ['process.view_all', 'settlement.view', 'damage.set_cost'],
    });
    const url = `/staff/settlements/${view.settlement.id}/clarifications/${open[0]!.id}/resolve`;
    const denied = await post(ctx.app, limited.cookie, url, {
      decision: 'charge',
      amountCents: 1500,
      version: view.settlement.version,
    });
    expect(denied.status).toBe(403);
    const ok = await post(ctx.app, cookie, url, {
      decision: 'charge',
      amountCents: 1500,
      version: view.settlement.version,
    });
    expect(ok.status).toBe(200);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'missing_item_charge')).toHaveLength(1);
    expect(lineOf(after, 'missing_item_charge')[0]).toMatchObject({
      amountCents: 1500,
      sourceType: 'missing_accessory_case',
      sourceId: world.missingCaseIds[0],
    });
    expect(after.settlement.noticeRequired).toBe(true);
    expect(after.settlement.status).toBe('customer_notice_required');
  });

  it('22. Teil später gebracht + Phase-7-Fall erledigt ⇒ Klärung beim Laden automatisch erledigt, keine Position, kein Blocker', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      missing: [{ accessoryType: 'drip_tray', quantity: 1 }],
    });
    expect(view.settlement.status).toBe('clarification_required');
    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/staff/missing-items/${world.missingCaseIds[0]}/resolve`,
      headers: { cookie },
    });
    expect(resolved.statusCode).toBe(200);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(openClarifications(after)).toEqual([]);
    expect(after.clarifications.find((c) => c.type === 'missing_item_cost')).toMatchObject({
      status: 'resolved',
      resolution: 'already_resolved',
    });
    expect(lineOf(after, 'missing_item_charge')).toEqual([]);
    expect(after.settlement.status).toBe('ready_for_accounting');
    expect(after.settlement.autoTransferPlannedAt).not.toBeNull();
  });

  it('24. Fehlteil „ohne Berechnung erledigen“ ⇒ keine Position, Fall in Phase 7 bleibt offen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      missing: [{ accessoryType: 'lid', quantity: 1 }],
    });
    const open = openClarifications(view, 'missing_item_cost')[0]!;
    const ok = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${open.id}/resolve`,
      { decision: 'no_charge', version: view.settlement.version },
    );
    expect(ok.status).toBe(200);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'missing_item_charge')).toEqual([]);
    expect(after.settlement.status).toBe('ready_for_accounting');
    const cases = await ctx.app.inject({
      method: 'GET',
      url: '/staff/missing-items',
      headers: { cookie },
    });
    expect(cases.json().cases.map((c: { id: string }) => c.id)).toContain(world.missingCaseIds[0]);
  });
});

describe('Manuelle Nachbelastungen (§89)', () => {
  it('27./28./29. Keine automatische Verspätungsgebühr; manuelle late_fee mit Recht; Kulanz ⇒ keine Position', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    expect(lineOf(view, 'late_fee')).toEqual([]);
    // Kulanz = keine Aktion: nichts entsteht automatisch, auch nach erneutem Laden.
    expect(lineOf(await settlementById(ctx.app, cookie, view.settlement.id), 'late_fee')).toEqual(
      [],
    );
    const added = await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'late_fee',
      description: 'Verspätete Rückgabe (2 Tage)',
      amountCents: 3000,
      internalNote: 'Mit Kunde besprochen',
      version: view.settlement.version,
    });
    expect(added.status).toBe(200);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'late_fee')).toHaveLength(1);
    expect(lineOf(after, 'late_fee')[0]).toMatchObject({
      amountCents: 3000,
      typeLabel: 'Verspätungsgebühr',
      internalNote: 'Mit Kunde besprochen',
      editable: true,
      removable: true,
    });
    expect(after.settlement.chargesTotalCents).toBe(3000);
    expect(after.settlement.amountDueCents).toBe(10500);
    // Verspätungsgebühr allein löst KEINE Kundeninformation aus (§24).
    expect(after.settlement.noticeRequired).toBe(false);
  });

  it('30./31./32. manual_charge: Beschreibung Pflicht, Recht Pflicht, negative/Null-Beträge abgelehnt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    const url = `/staff/settlements/${view.settlement.id}/lines`;
    const noDescription = await post(ctx.app, cookie, url, {
      type: 'manual_charge',
      description: '   ',
      amountCents: 1000,
      version: view.settlement.version,
    });
    expect(noDescription.status).toBe(400);
    const negative = await post(ctx.app, cookie, url, {
      type: 'manual_charge',
      description: 'Gutschrift getarnt',
      amountCents: -1000,
      version: view.settlement.version,
    });
    expect(negative.status).toBe(400);
    const zero = await post(ctx.app, cookie, url, {
      type: 'manual_charge',
      description: 'Null',
      amountCents: 0,
      version: view.settlement.version,
    });
    expect(zero.status).toBe(400);
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Nachbelastung',
      email: 'ohne.nachbelastung@test.example',
      password: 'ohne-nachbelastung-passwort-1',
      permissionKeys: ['process.view_all', 'settlement.view', 'settlement.release'],
    });
    const denied = await post(ctx.app, limited.cookie, url, {
      type: 'manual_charge',
      description: 'Zusätzliche Reinigung Zubehör',
      amountCents: 1000,
      version: view.settlement.version,
    });
    expect(denied.status).toBe(403);
    const ok = await post(ctx.app, cookie, url, {
      type: 'manual_charge',
      description: 'Zusätzliche Reinigung Zubehör',
      amountCents: 1000,
      version: view.settlement.version,
    });
    expect(ok.status).toBe(200);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'manual_charge')).toHaveLength(1);
    expect(lineOf(after, 'manual_charge')[0]!.description).toBe('Zusätzliche Reinigung Zubehör');
    // Veraltete Version ⇒ 409 VERSION_CONFLICT (kein Lost Update).
    const stale = await post(ctx.app, cookie, url, {
      type: 'manual_charge',
      description: 'Nochmal',
      amountCents: 500,
      version: view.settlement.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('VERSION_CONFLICT');
  });
});
