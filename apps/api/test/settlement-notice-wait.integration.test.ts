/**
 * Phase-9-Pflichttests §91 (44–60): Kundeninformation vor Schaden-/
 * Fehlteilbelastung (eine kombinierte, Freigabe + Testversand, Production
 * ohne Adapter blockiert), 24-h-Wartefenster (wait_until exakt +24 h, nur
 * einmal je Abrechnung), Kundenrückmeldung, „wie berechnet freigeben“,
 * Betragsänderung/Entfernung nach Versand, „Jetzt freigeben“, Auto-Transfer
 * nach Ablauf und erneute Prüfung des Workers (TOCTOU).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { DisabledMailGateway } from '../src/communication/mail/gateways.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { jpegBytes, POINT_MARKER } from './return-helpers.ts';
import {
  adminSession,
  backdateSentNotice,
  drainAllJobs,
  lineOf,
  openClarifications,
  post,
  resetSettlementWorld,
  sentNoticeMails,
  settledReturn,
  settlementServiceFor,
  settlementViewFor,
  type FinalizedReturn,
} from './settlement-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

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

const HOUR = 3_600_000;

/** Phase 12 (Retention §25): Status der Foto-Retention-Jobs eines Vorgangs. */
async function retentionJobStatuses(processId: string): Promise<string[]> {
  const result = await ctx.pool.query<{ status: string }>(
    `SELECT status FROM integration_jobs
      WHERE type = 'communication.cleanup_retention' AND payload->>'processId' = $1`,
    [processId],
  );
  return result.rows.map((row) => row.status);
}

/** Finalisierte Rückgabe mit einem Schaden, Schadenkosten `amount` berechnet. */
async function chargedDamage(cookie: string, adminId: string, amount = 5000) {
  const { world, view } = await settledReturn(ctx, adminId, cookie, {
    damages: [{ description: 'Riss im Deckel', severity: 'light' }],
  });
  const clarification = openClarifications(view, 'damage_cost')[0]!;
  const decided = await post(
    ctx.app,
    cookie,
    `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
    { decision: 'charge', amountCents: amount, version: view.settlement.version },
  );
  expect(decided.status).toBe(200);
  return { world, view: await settlementViewFor(ctx.app, cookie, world.processId) };
}

async function sendNotice(cookie: string, processId: string) {
  const current = await settlementViewFor(ctx.app, cookie, processId);
  const sent = await post(
    ctx.app,
    cookie,
    `/staff/settlements/${current.settlement.id}/notice/approve-and-send`,
    {
      version: current.settlement.version,
    },
  );
  expect(sent.status).toBe(200);
  // Phase 12: Freigabe reiht nur ein – die Frist beginnt erst mit bestätigtem Mailversand (mail.send).
  await drainAllJobs(ctx);
  return settlementViewFor(ctx.app, cookie, processId);
}

/**
 * Versand mit rückdatiertem Zeitpunkt (Frist bereits abgelaufen): Freigabe über
 * den Service, Mailversand über den Test-Runner, danach Frist/Auto-Job in die
 * Vergangenheit verschoben (Phase 12: die Frist beginnt erst nach Mailerfolg).
 */
async function sendNoticeBackdated(
  adminId: string,
  cookie: string,
  processId: string,
  hoursAgo = 25,
) {
  const current = await settlementViewFor(ctx.app, cookie, processId);
  const sentAt = new Date(Date.now() - hoursAgo * HOUR);
  await settlementServiceFor(ctx).approveAndSendNotice(
    adminId,
    current.settlement.id,
    current.settlement.version,
    sentAt,
  );
  await drainAllJobs(ctx);
  await backdateSentNotice(ctx, current.settlement.id, sentAt);
  return settlementViewFor(ctx.app, cookie, processId);
}

async function postReturnFinding(adminId: string, world: FinalizedReturn) {
  const machine = await machineByCode(ctx.db, world.machineCodes[0]!);
  return world.services.damages.createPostReturnFinding(adminId, machine.id, {
    severity: 'severe',
    description: 'Nachträglich: Gehäuse gebrochen',
    markers: [POINT_MARKER],
    photo: { bytes: jpegBytes(), mimeType: 'image/jpeg' },
  });
}

describe('Kundeninformation (§91)', () => {
  it('44./48. Schadenbetrag > 0 ⇒ Information erforderlich, vorbereitet, ohne Freigabe nicht gesendet; Transfer blockiert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await chargedDamage(cookie, admin.id);
    expect(view.settlement.noticeRequired).toBe(true);
    expect(view.settlement.status).toBe('customer_notice_required');
    expect(view.settlement.statusLabel).toBe('Kundeninformation erforderlich');
    expect(view.dominantAction).toMatchObject({
      key: 'review_notice',
      label: 'Kundeninformation prüfen',
    });
    expect(view.notice).toMatchObject({
      status: 'prepared',
      recipientEmail: 'klara.kommerz@test.example',
      totalCents: 5000,
    });
    expect(view.notice!.subject).toBe(
      `Information zu Ihrer Rückgabe – Vorgang ${view.settlement.processNumber}`,
    );
    expect(view.notice!.bodyText).toContain('Riss im Deckel');
    expect(view.notice!.bodyText).toContain('50,00 EUR');
    expect(view.notice!.bodyText).toContain('Rückgabeprotokoll');
    expect(view.notice!.bodyText).not.toMatch(/MwSt|Mahnung|rechtliche Schritte/i);
    expect(view.settlement.noticeSentAt).toBeNull();
    expect(await sentNoticeMails(ctx)).toHaveLength(0);
    const notice = await ctx.app.inject({
      method: 'GET',
      url: `/staff/settlements/${view.settlement.id}/notice`,
      headers: { cookie },
    });
    expect(notice.statusCode).toBe(200);
    expect(notice.json().positions).toHaveLength(1);
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      { version: view.settlement.version },
    );
    expect(transfer.status).toBe(409);
    expect(transfer.body.error?.code).toBe('TRANSFER_NOT_READY');
    expect(ctx.accounting.calls).toHaveLength(0);
    expect(view.settlement.autoTransferPlannedAt).toBeNull();
  });

  it('45. Fehlteilbetrag > 0 ⇒ Information erforderlich', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      missing: [{ accessoryType: 'lid', quantity: 1 }],
    });
    const clarification = openClarifications(view, 'missing_item_cost')[0]!;
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      {
        decision: 'charge',
        amountCents: 1500,
        version: view.settlement.version,
      },
    );
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.noticeRequired).toBe(true);
    expect(after.settlement.status).toBe('customer_notice_required');
    expect(after.notice!.bodyText).toContain('Deckel');
  });

  it('46. Nur Reinigungsgebühr (und manuelle Nachbelastung) ⇒ keine Kundeninformation, direkt bereit', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { cleanupMachines: [0] });
    await post(ctx.app, cookie, `/staff/settlements/${view.settlement.id}/lines`, {
      type: 'manual_charge',
      description: 'Sonderreinigung Zubehör',
      amountCents: 1000,
      version: view.settlement.version,
    });
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.noticeRequired).toBe(false);
    expect(after.notice).toBeNull();
    expect(after.settlement.status).toBe('ready_for_accounting');
  });

  it('47./50./51. Mehrere Schäden + Fehlteil ⇒ EINE kombinierte Information; Testversand setzt sent_at, wait_until exakt +24 h', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer links' }, { description: 'Delle hinten' }],
      missing: [{ accessoryType: 'drip_tray', quantity: 1 }],
    });
    let current = view;
    const amounts: Record<string, number> = { damage_cost: 2000, missing_item_cost: 800 };
    for (const clarification of openClarifications(view)) {
      const amount = amounts[clarification.type]!;
      const decided = await post(
        ctx.app,
        cookie,
        `/staff/settlements/${current.settlement.id}/clarifications/${clarification.id}/resolve`,
        {
          decision: 'charge',
          amountCents: amount,
          version: current.settlement.version,
        },
      );
      expect(decided.status).toBe(200);
      current = await settlementViewFor(ctx.app, cookie, world.processId);
    }
    expect(current.notice!.totalCents).toBe(4800);
    expect(current.notice!.bodyText).toContain('Kratzer links');
    expect(current.notice!.bodyText).toContain('Delle hinten');
    expect(current.notice!.bodyText).toContain('Tropfschale');
    expect(current.notice!.bodyText).toContain('48,00 EUR');
    const sent = await sendNotice(cookie, world.processId);
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
    expect((await sentNoticeMails(ctx))[0]!.recipientEmail).toBe('klara.kommerz@test.example');
    expect(sent.notice).toMatchObject({ status: 'sent', gateway: 'mail' });
    expect(sent.settlement.noticeSentAt).not.toBeNull();
    expect(
      new Date(sent.settlement.waitUntil!).getTime() -
        new Date(sent.settlement.noticeSentAt!).getTime(),
    ).toBe(24 * HOUR);
    expect(sent.settlement.status).toBe('customer_waiting');
    expect(sent.settlement.statusLabel).toBe('Kundenrückmeldung abwarten');
    expect(sent.dominantAction.key).toBe('wait');
    expect(sent.settlement.autoTransferPlannedAt).toBe(sent.settlement.waitUntil);
    // Nur einmal je Abrechnung (§28).
    const again = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${sent.settlement.id}/notice/approve-and-send`,
      { version: sent.settlement.version },
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('NOTICE_ALREADY_SENT');
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
  });

  it('49. Ohne Versandadapter (Mail deaktiviert) wird nichts gesendet: 409, Notice blocked, keine Frist', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await chargedDamage(cookie, admin.id);
    const app = buildApp({
      config: ctx.config,
      pool: ctx.pool,
      mailAdapter: ctx.mail,
      rateLimitEnabled: false,
      storage: ctx.storage,
      accountingGateway: ctx.accounting,
      mailGateway: new DisabledMailGateway(),
      jobQueue: ctx.queue,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/staff/settlements/${view.settlement.id}/notice/approve-and-send`,
        headers: { cookie },
        payload: { version: view.settlement.version },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('NOTICE_NOT_CONFIGURED');
    } finally {
      await app.close();
    }
    const after = await settlementViewFor(ctx.app, cookie, view.settlement.processId);
    expect(after.notice!.status).toBe('blocked');
    expect(after.settlement.noticeSentAt).toBeNull();
    expect(after.settlement.waitUntil).toBeNull();
    expect(after.settlement.status).toBe('customer_notice_required');
    expect(await sentNoticeMails(ctx)).toHaveLength(0);
  });

  it('52. Spätere Position nach Versand: Frist startet NICHT neu, keine zweite Information, kein Auto-Transfer', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    const sent = await sendNotice(cookie, world.processId);
    await postReturnFinding(admin.id, world);
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('clarification_required');
    const clarification = openClarifications(current, 'damage_cost')[0]!;
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/clarifications/${clarification.id}/resolve`,
      {
        decision: 'charge',
        amountCents: 9000,
        version: current.settlement.version,
      },
    );
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.waitUntil).toBe(sent.settlement.waitUntil);
    expect(current.settlement.noticeSentAt).toBe(sent.settlement.noticeSentAt);
    expect(current.settlement.amountsChangedAfterNoticeAt).not.toBeNull();
    expect(current.settlement.manualTransferRequired).toBe(true);
    expect(current.settlement.chargesTotalCents).toBe(14000);
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
    expect(current.settlement.status).toBe('customer_waiting');
    expect(current.settlement.autoTransferPlannedAt).toBeNull();
  });

  it('53./54. Kundenrückmeldung blockiert Auto-Transfer; „wie berechnet freigeben“ ermöglicht manuellen Transfer', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    let current = await sendNoticeBackdated(admin.id, cookie, world.processId);
    expect(current.settlement.status).toBe('ready_for_accounting');
    // Rückmeldung VOR dem Job (TOCTOU-Fall: Job ist bereits fällig).
    // Eine Notiz gehört nicht zur Rückmeldung (Order §30) – strictObject lehnt sie ab.
    const withNote = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/customer-response`,
      { note: 'Kunde bestreitet den Riss', version: current.settlement.version },
    );
    expect(withNote.status).toBe(400);
    const response = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/customer-response`,
      { version: current.settlement.version },
    );
    expect(response.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.customerResponseReceivedAt).not.toBeNull();
    expect(current.settlement.manualTransferRequired).toBe(true);
    expect(current.settlement.status).toBe('clarification_required');
    expect(openClarifications(current, 'customer_response')).toHaveLength(1);
    expect(current.dominantAction).toMatchObject({
      key: 'release_as_calculated',
      label: 'Wie berechnet freigeben',
    });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(0);
    const twice = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/customer-response`,
      { version: current.settlement.version },
    );
    expect(twice.status).toBe(409);
    const released = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/release`,
      { version: current.settlement.version },
    );
    expect(released.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.releasedAt).not.toBeNull();
    expect(current.settlement.status).toBe('ready_for_accounting');
    expect(current.settlement.manualTransferRequired).toBe(true);
    expect(current.dominantAction).toMatchObject({
      key: 'transfer_now',
      label: 'Jetzt an Buchhaltung übertragen',
    });
    expect(await ctx.jobs.runOnce()).toBe('idle');
    expect(ctx.accounting.calls).toHaveLength(0);
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(transfer.status).toBe(200);
    expect(transfer.body.outcome).toBe('succeeded');
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.accounting.calls[0]!.amountDueCents).toBe(12500);
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
  });

  it('55. Betrag nach Versand geändert ⇒ neue Summe sichtbar, kein Auto-Transfer, keine zweite Mail, manuell möglich', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    let current = await sendNoticeBackdated(admin.id, cookie, world.processId);
    const line = lineOf(current, 'damage_charge')[0]!;
    const edited = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      {
        amountCents: 3000,
        version: current.settlement.version,
      },
      'PATCH',
    );
    expect(edited.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.amountsChangedAfterNoticeAt).not.toBeNull();
    expect(current.settlement.manualTransferRequired).toBe(true);
    expect(current.settlement.amountDueCents).toBe(10500);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(0);
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(transfer.status).toBe(200);
    expect(ctx.accounting.calls[0]!.amountDueCents).toBe(10500);
  });

  it('56. Position nach Versand entfernt ⇒ Blocker neu berechnet: keine Information mehr nötig ⇒ läuft automatisch weiter (DOMAIN_RULES, Order §33)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    let current = await sendNotice(cookie, world.processId);
    expect(current.settlement.status).toBe('customer_waiting');
    const line = lineOf(current, 'damage_charge')[0]!;
    const removed = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { version: current.settlement.version },
      'DELETE',
    );
    expect(removed.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(current, 'damage_charge')).toEqual([]);
    expect(current.settlement.noticeRequired).toBe(false);
    expect(current.clarifications.find((c) => c.type === 'damage_cost')).toMatchObject({
      status: 'resolved',
      resolution: 'not_charged',
    });
    expect(current.settlement.status).toBe('ready_for_accounting');
    expect(current.settlement.manualTransferRequired).toBe(false);
    expect(current.settlement.amountsChangedAfterNoticeAt).toBeNull();
    expect(current.settlement.amountDueCents).toBe(7500);
    expect(current.dominantAction.key).toBe('auto_planned');
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
    // Der beim Versand eingestellte Job wurde vorgezogen und überträgt sofort.
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.accounting.calls[0]!.amountDueCents).toBe(7500);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transferred');
  });

  it('56b. Eine von zwei Positionen nach Versand entfernt ⇒ Frist läuft weiter, Auto-Job am Fristende überträgt den niedrigeren Betrag', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer links' }, { description: 'Delle hinten' }],
    });
    let current = view;
    for (const clarification of openClarifications(view, 'damage_cost')) {
      const decided = await post(
        ctx.app,
        cookie,
        `/staff/settlements/${current.settlement.id}/clarifications/${clarification.id}/resolve`,
        { decision: 'charge', amountCents: 2000, version: current.settlement.version },
      );
      expect(decided.status).toBe(200);
      current = await settlementViewFor(ctx.app, cookie, world.processId);
    }
    current = await sendNotice(cookie, world.processId);
    const line = lineOf(current, 'damage_charge')[0]!;
    const removed = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { version: current.settlement.version },
      'DELETE',
    );
    expect(removed.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('customer_waiting');
    expect(current.settlement.manualTransferRequired).toBe(false);
    expect(current.settlement.amountsChangedAfterNoticeAt).toBeNull();
    expect(current.settlement.amountDueCents).toBe(9500);
    expect(await ctx.jobs.runOnce()).toBe('idle');
    // Fristende (Mock-Steuerung) ⇒ Auto-Transfer mit dem niedrigeren Betrag.
    const expire = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/expire-wait',
      headers: { cookie },
      payload: { settlementId: current.settlement.id },
    });
    expect(expire.statusCode).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('ready_for_accounting');
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.accounting.calls[0]!.amountDueCents).toBe(9500);
    expect(await sentNoticeMails(ctx)).toHaveLength(1);
  });

  it('53b. Kundenrückmeldung → Position entfernt ⇒ Rückmeldung bearbeitet, ohne weitere Blocker überträgt der Auto-Job (DOMAIN_RULES)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    let current = await sendNoticeBackdated(admin.id, cookie, world.processId);
    const response = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/customer-response`,
      { version: current.settlement.version },
    );
    expect(response.status).toBe(200);
    expect(await ctx.jobs.runOnce()).toBe('processed'); // übersprungen, kein Transfer
    expect(ctx.accounting.calls).toHaveLength(0);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('clarification_required');
    const line = lineOf(current, 'damage_charge')[0]!;
    const removed = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { version: current.settlement.version },
      'DELETE',
    );
    expect(removed.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.clarifications.find((c) => c.type === 'customer_response')).toMatchObject({
      status: 'resolved',
      resolution: 'position_removed',
    });
    expect(current.settlement.customerResponseReceivedAt).not.toBeNull();
    expect(current.settlement.manualTransferRequired).toBe(false);
    expect(current.settlement.status).toBe('ready_for_accounting');
    expect(current.dominantAction.key).toBe('auto_planned');
    // Neue Job-Generation nach dem Skip ⇒ Auto-Transfer läuft.
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(ctx.accounting.calls[0]!.amountDueCents).toBe(7500);
    expect((await settlementViewFor(ctx.app, cookie, world.processId)).settlement.status).toBe(
      'transferred',
    );
  });

  it('57./58. „Jetzt freigeben“ beendet das Warten (Recht settlement.end_pre_notice_wait), transferiert NICHT automatisch', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    let current = await sendNotice(cookie, world.processId);
    const beforeWait = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(beforeWait.status).toBe(409);
    const ended = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/end-wait`,
      { version: current.settlement.version },
    );
    expect(ended.status).toBe(200);
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.earlyReleasedAt).not.toBeNull();
    expect(current.settlement.status).toBe('ready_for_accounting');
    expect(current.settlement.manualTransferRequired).toBe(true);
    expect(current.dominantAction.key).toBe('transfer_now');
    // Der beim Versand eingestellte Job ist erst zum Fristende fällig – und wird dann übersprungen.
    expect(await ctx.jobs.runOnce()).toBe('idle');
    await ctx.pool.query(`UPDATE integration_jobs SET run_at = now() - interval '1 minute'`);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(ctx.accounting.calls).toHaveLength(0);
    const again = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/end-wait`,
      { version: current.settlement.version },
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('NOT_WAITING');
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(transfer.body.outcome).toBe('succeeded');
    expect(ctx.accounting.calls).toHaveLength(1);
  });

  it('59. 24 h ohne Rückmeldung ⇒ Auto-Transfer fällig: Worker überträgt genau einmal, Abrechnung gesperrt, Vorgang abgeschlossen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    const current = await sendNoticeBackdated(admin.id, cookie, world.processId);
    expect(current.settlement.status).toBe('ready_for_accounting');
    expect(current.settlement.manualTransferRequired).toBe(false);
    expect(current.dominantAction.key).toBe('auto_planned');
    expect(await ctx.jobs.runOnce()).toBe('processed');
    // Phase 12 (Retention §25): der Abschluss durch den Transfer reiht genau EINEN
    // Foto-Retention-Job ein – danach nichts mehr (insbesondere kein zweiter Transfer).
    expect(await ctx.jobs.runOnce()).toBe('processed');
    expect(await ctx.jobs.runOnce()).toBe('idle');
    expect(await retentionJobStatuses(world.processId)).toEqual(['succeeded']);
    expect(ctx.accounting.calls).toHaveLength(1);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.status).toBe('transferred');
    expect(after.settlement.locked).toBe(true);
    expect(after.settlement.paymentStatus).toBe('open');
    const process = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}`,
      headers: { cookie },
    });
    expect(process.json().process.mainStatus).toBe('completed');
  });

  it('59b. Mock „Frist ablaufen lassen“ + „fällige Jobs ausführen“ (E2E-Pfad D): genau ein Transfer, Abrechnung gesperrt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    const sent = await sendNotice(cookie, world.processId);
    expect(sent.settlement.status).toBe('customer_waiting');
    // Vor Ablauf: der Job ist nicht fällig.
    const early = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/run-due-jobs',
      headers: { cookie },
      payload: {},
    });
    expect(early.json()).toMatchObject({ processed: 0, failed: 0 });
    const expire = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/expire-wait',
      headers: { cookie },
      payload: { settlementId: sent.settlement.id },
    });
    expect(expire.statusCode).toBe(200);
    // Das Laden bewertet Frist und Job-Fälligkeit neu (kein Scanner nötig).
    const due = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(due.settlement.status).toBe('ready_for_accounting');
    expect(due.dominantAction.key).toBe('auto_planned');
    const run = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/run-due-jobs',
      headers: { cookie },
      payload: {},
    });
    // Phase 12 (Retention §25): Transfer-Job + der durch den Abschluss eingereihte Foto-Retention-Job.
    expect(run.json()).toMatchObject({ processed: 2, failed: 0 });
    expect(await retentionJobStatuses(world.processId)).toEqual(['succeeded']);
    expect(ctx.accounting.calls).toHaveLength(1);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(after.settlement.status).toBe('transferred');
    expect(after.settlement.locked).toBe(true);
  });

  it('60. Worker prüft beim Lauf erneut: Rückmeldung nach Einstellung des Jobs ⇒ übersprungen, kein Transfer', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await chargedDamage(cookie, admin.id);
    const current = await sendNoticeBackdated(admin.id, cookie, world.processId);
    const service = settlementServiceFor(ctx);
    // Rückmeldung und Job-Lauf parallel: entweder blockiert die Rückmeldung den Lauf,
    // oder der Lauf hat bereits übertragen – nie beides halb.
    const [response] = await Promise.all([
      post(ctx.app, cookie, `/staff/settlements/${current.settlement.id}/customer-response`, {
        version: current.settlement.version,
      }),
      ctx.jobs.runOnce(),
    ]);
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    if (response.status === 200) {
      expect(after.settlement.status).toBe('clarification_required');
      expect(ctx.accounting.calls).toHaveLength(0);
      expect(await service.runAutoTransfer(after.settlement.id)).toEqual({ outcome: 'skipped' });
    } else {
      expect(response.body.error?.code).toBe('SETTLEMENT_LOCKED');
      expect(after.settlement.status).toBe('transferred');
      expect(ctx.accounting.calls).toHaveLength(1);
    }
  });
});
