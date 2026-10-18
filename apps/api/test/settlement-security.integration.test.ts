/**
 * Phase-9-Pflichttests §97 (130–135, 138–142, 146–149): IDOR-Schutz der
 * Abrechnungsrouten (fremde/unbekannte IDs ⇒ 404), clientseitig nicht
 * setzbare Felder (transferred, accountingReference, cleanupFee,
 * chargeableQuantity ⇒ 400), Betragsänderungen nur mit Recht, keine
 * sensiblen Daten im Serverlog, Offline ohne Finanzmutation, Snapshot nach
 * Transfer unveränderbar.
 */
import { Writable } from 'node:stream';
import { accountingTransfers, settlementLines } from '@mietroyal/database';
import { MUTATION_PERMISSIONS } from '@mietroyal/offline/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCompletedVisibilityDays } from '../src/crm/settings-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import {
  adminSession,
  lineOf,
  openClarifications,
  post,
  resetSettlementWorld,
  settledReturn,
  settlementViewFor,
} from './settlement-helpers.ts';

let ctx: TestContext;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetSettlementWorld(ctx);
  logLines.length = 0;
});

const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const FINANCE_KEYS = [
  'process.view_all',
  'settlement.view',
  'settlement.add_manual_charge',
  'settlement.release',
  'settlement.end_pre_notice_wait',
  'damage.set_cost',
  'damage.edit_cost_before_lexware',
  'missing_item.set_cost',
  'deposit.record_advance',
  'deposit.record_security',
  'deposit.retain_security',
  'deposit.refund_security',
  'lexware.manual_transfer',
] as const;

/** Finanz-Mitarbeiter ohne process.view_completed: abgeschlossene Vorgänge mit Sichtbarkeit 0 Tage sind für ihn unsichtbar. */
async function financeStaff(adminId: string) {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: 'Finanz',
    lastName: 'Mitarbeiter',
    email: 'finanz@test.example',
    password: 'finanz-passwort-12345',
    permissionKeys: [...FINANCE_KEYS],
  });
}

describe('IDOR (130–135)', () => {
  it('130./131./132./133./135. Settlement, Line, Schaden-/Fehlteilkosten und Transfer: fremde (unsichtbare) und unbekannte IDs ⇒ 404', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer' }],
      missing: [{ accessoryType: 'lid', quantity: 1 }],
    });
    const damageClarification = openClarifications(view, 'damage_cost')[0]!;
    const missingClarification = openClarifications(view, 'missing_item_cost')[0]!;
    const rental = lineOf(view, 'machine_rental')[0]!;
    const staff = await financeStaff(admin.id);
    // Unbekannte IDs.
    for (const [method, url, payload] of [
      ['GET', `/staff/settlements/${UNKNOWN}`, undefined],
      ['GET', `/staff/processes/${UNKNOWN}/settlement`, undefined],
      [
        'PATCH',
        `/staff/settlements/${view.settlement.id}/lines/${UNKNOWN}`,
        { amountCents: 1, version: 1 },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/clarifications/${UNKNOWN}/resolve`,
        { decision: 'no_charge', version: 1 },
      ],
      ['POST', `/staff/settlements/${UNKNOWN}/transfer`, { version: 1 }],
      [
        'POST',
        `/staff/settlements/${UNKNOWN}/lines`,
        { type: 'late_fee', description: 'x', amountCents: 1, version: 1 },
      ],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie: staff.cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    // Vorgang abschließen und Sichtbarkeit auf 0 Tage ⇒ für den Finanz-Mitarbeiter unsichtbar.
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/complete`,
      headers: { cookie },
    });
    expect(complete.statusCode).toBe(200);
    await setCompletedVisibilityDays(ctx.db, admin.id, 0);
    for (const [method, url, payload] of [
      ['GET', `/staff/settlements/${view.settlement.id}`, undefined],
      ['GET', `/staff/processes/${world.processId}/settlement`, undefined],
      ['POST', `/staff/processes/${world.processId}/settlement/ensure`, undefined],
      ['GET', `/staff/settlements/${view.settlement.id}/notice`, undefined],
      [
        'PATCH',
        `/staff/settlements/${view.settlement.id}/lines/${rental.id}`,
        { amountCents: 1, version: view.settlement.version },
      ],
      [
        'DELETE',
        `/staff/settlements/${view.settlement.id}/lines/${rental.id}`,
        { version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/clarifications/${damageClarification.id}/resolve`,
        { decision: 'charge', amountCents: 1, version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/clarifications/${missingClarification.id}/resolve`,
        { decision: 'charge', amountCents: 1, version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/lines`,
        { type: 'late_fee', description: 'x', amountCents: 1, version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/transfer`,
        { version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/end-wait`,
        { version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/release`,
        { version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/customer-response`,
        { version: view.settlement.version },
      ],
      [
        'POST',
        `/staff/settlements/${view.settlement.id}/notice/approve-and-send`,
        { version: view.settlement.version },
      ],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie: staff.cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    // Admin (view_completed) sieht weiterhin alles; nichts wurde verändert.
    const adminView = await ctx.app.inject({
      method: 'GET',
      url: `/staff/settlements/${view.settlement.id}`,
      headers: { cookie },
    });
    expect(adminView.statusCode).toBe(200);
    expect(openClarifications(adminView.json())).toHaveLength(2);
    expect(ctx.accounting.calls).toHaveLength(0);
  });

  it('134. Zahlungen/Kaution: fremde Buchung bzw. unbekannte IDs ⇒ 404; keine Erfassung', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/security-deposits`, {
      amountCents: 5000,
      receivedAt: '2026-10-01',
    });
    await post(ctx.app, cookie, `/staff/bookings/${world.bookingId}/advance-payments`, {
      amountCents: 1000,
      receivedAt: '2026-10-01',
    });
    const paymentsBefore = await ctx.app.inject({
      method: 'GET',
      url: `/staff/bookings/${world.bookingId}/payments`,
      headers: { cookie },
    });
    const depositId = paymentsBefore.json().securityDeposits[0].id as string;
    const advanceId = paymentsBefore.json().advancePayments[0].id as string;
    const staff = await financeStaff(admin.id);
    await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/complete`,
      headers: { cookie },
    });
    await setCompletedVisibilityDays(ctx.db, admin.id, 0);
    for (const [method, url, payload] of [
      ['GET', `/staff/bookings/${world.bookingId}/payments`, undefined],
      ['GET', `/staff/bookings/${UNKNOWN}/payments`, undefined],
      [
        'POST',
        `/staff/bookings/${world.bookingId}/advance-payments`,
        { amountCents: 100, receivedAt: '2026-10-01' },
      ],
      [
        'POST',
        `/staff/bookings/${UNKNOWN}/security-deposits`,
        { amountCents: 100, receivedAt: '2026-10-01' },
      ],
      ['POST', `/staff/advance-payments/${advanceId}/cancel`, {}],
      ['POST', `/staff/advance-payments/${UNKNOWN}/cancel`, {}],
      ['POST', `/staff/security-deposits/${depositId}/apply`, { amountCents: 100, version: 1 }],
      ['POST', `/staff/security-deposits/${depositId}/release`, { version: 1 }],
      ['POST', `/staff/security-deposits/${UNKNOWN}/apply`, { amountCents: 100, version: 1 }],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie: staff.cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/staff/bookings/${world.bookingId}/payments`,
      headers: { cookie },
    });
    expect(after.json().securityDeposits[0]).toMatchObject({
      status: 'held',
      appliedCents: 0,
      version: 1,
    });
    expect(after.json().advancePayments[0]).toMatchObject({ status: 'active' });
  });
});

describe('Manipulation (138–142)', () => {
  it('138./139. Client kann weder transferred/status noch accountingReference setzen (strictObject ⇒ 400); Referenz nur über Gateway', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { view } = await settledReturn(ctx, admin.id, cookie);
    const base = `/staff/settlements/${view.settlement.id}`;
    for (const [url, payload] of [
      [`${base}/transfer`, { version: view.settlement.version, transferred: true }],
      [
        `${base}/transfer`,
        { version: view.settlement.version, accountingReference: 'RE-2026-0001' },
      ],
      [`${base}/transfer`, { version: view.settlement.version, status: 'transferred' }],
      [
        `${base}/lines`,
        {
          type: 'late_fee',
          description: 'x',
          amountCents: 100,
          version: view.settlement.version,
          status: 'transferred',
        },
      ],
      [`${base}/release`, { version: view.settlement.version, accountingReference: 'RE-1' }],
      [`${base}/end-wait`, { version: view.settlement.version, transferred: true }],
    ] as const) {
      const response = await ctx.app.inject({ method: 'POST', url, headers: { cookie }, payload });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    const current = await settlementViewFor(ctx.app, cookie, view.settlement.processId);
    expect(current.settlement.status).toBe('ready_for_accounting');
    expect(current.settlement.accountingReference).toBeNull();
    expect(ctx.accounting.calls).toHaveLength(0);
  });

  it('140. Schaden-/Fehlteilbetrag ohne Recht nicht setzbar – auch nicht über Line-PATCH', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer' }],
    });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Recht',
      email: 'ohne.recht@test.example',
      password: 'ohne-recht-passwort-123',
      permissionKeys: [
        'process.view_all',
        'settlement.view',
        'settlement.add_manual_charge',
        'settlement.release',
        'lexware.manual_transfer',
      ],
    });
    const denied = await post(
      ctx.app,
      limited.cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      {
        decision: 'charge',
        amountCents: 99999,
        version: view.settlement.version,
      },
    );
    expect(denied.status).toBe(403);
    const noCharge = await post(
      ctx.app,
      limited.cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      {
        decision: 'no_charge',
        version: view.settlement.version,
      },
    );
    expect(noCharge.status).toBe(403);
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      {
        decision: 'charge',
        amountCents: 5000,
        version: view.settlement.version,
      },
    );
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    const line = lineOf(current, 'damage_charge')[0]!;
    const patch = await post(
      ctx.app,
      limited.cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { amountCents: 1, version: current.settlement.version },
      'PATCH',
    );
    expect(patch.status).toBe(403);
    const remove = await post(
      ctx.app,
      limited.cookie,
      `/staff/settlements/${current.settlement.id}/lines/${line.id}`,
      { version: current.settlement.version },
      'DELETE',
    );
    expect(remove.status).toBe(403);
    expect(
      lineOf(await settlementViewFor(ctx.app, cookie, world.processId), 'damage_charge')[0]!
        .amountCents,
    ).toBe(5000);
  });

  it('141./142. Reinigungsgebühr und Kommissionsmenge sind Fakten: nicht per PATCH/DELETE änderbar (409), Fremdfelder ⇒ 400', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      cleanupMachines: [0],
      machineSlug: 'slush-2x10',
      machineCodes: ['MR-10-02-01'],
      selections: [{ slug: 'sirup-kirsche', role: 'extra', quantity: 2 }],
    });
    const cleanup = lineOf(view, 'cleanup_fee')[0]!;
    const commission = lineOf(view, 'commission_consumption')[0]!;
    expect(cleanup.amountCents).toBe(7500);
    expect(commission.quantity).toBe(2);
    for (const line of [cleanup, commission]) {
      const patch = await post(
        ctx.app,
        cookie,
        `/staff/settlements/${view.settlement.id}/lines/${line.id}`,
        { amountCents: 1, version: view.settlement.version },
        'PATCH',
      );
      expect(patch.status).toBe(409);
      expect(patch.body.error?.code).toBe('LINE_NOT_EDITABLE');
      const remove = await post(
        ctx.app,
        cookie,
        `/staff/settlements/${view.settlement.id}/lines/${line.id}`,
        { version: view.settlement.version },
        'DELETE',
      );
      expect(remove.status).toBe(409);
    }
    for (const payload of [
      { cleanupFee: 0, version: view.settlement.version },
      { chargeableQuantity: 0, version: view.settlement.version },
      { quantity: 0, version: view.settlement.version },
    ]) {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/staff/settlements/${view.settlement.id}/lines/${commission.id}`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const after = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(lineOf(after, 'cleanup_fee')[0]!.amountCents).toBe(7500);
    expect(lineOf(after, 'commission_consumption')[0]).toMatchObject({
      quantity: 2,
      amountCents: 2400,
    });
    expect(after.settlement.version).toBe(view.settlement.version);
  });
});

describe('Datenminimierung, Offline, Snapshot (146–149)', () => {
  it('146. Serverlog enthält keine Kundendaten, Rechnungsadresse, Schadensbeschreibung oder Buchhaltungsreferenz', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer am Gehäuse XYZ123' }],
    });
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      {
        decision: 'charge',
        amountCents: 4321,
        version: view.settlement.version,
      },
    );
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    await post(
      ctx.app,
      cookie,
      `/staff/settlements/${current.settlement.id}/notice/approve-and-send`,
      { version: current.settlement.version },
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
      { version: current.settlement.version },
    );
    expect(transfer.body.outcome).toBe('succeeded');
    current = await settlementViewFor(ctx.app, cookie, world.processId);
    const log = logLines.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain('klara.kommerz@test.example');
    expect(log).not.toContain('Kommerz');
    expect(log).not.toContain('XYZ123');
    expect(log).not.toContain(current.settlement.accountingReference!);
    // Kurze Ziffernfolge aus der Fixture: zufällige Request-/Entitäts-UUIDs können
    // sie zufällig enthalten (z. B. „…-4321-…“) – UUIDs vor dieser Prüfung neutralisieren.
    const logWithoutUuids = log.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>',
    );
    expect(logWithoutUuids).not.toContain('4321');
    expect(log).not.toContain('Lieferweg');
    // IDs/Status dürfen vorkommen (Nachvollziehbarkeit).
    expect(log).toContain(current.settlement.id);
  });

  it('148. Offline-Mutationen enthalten keine Finanzmutation (kein settlement./deposit./transfer-Typ)', () => {
    const types = Object.keys(MUTATION_PERMISSIONS);
    expect(types.length).toBeGreaterThan(0);
    expect(
      types.filter((type) =>
        /settlement|deposit|advance|transfer|accounting|cancellation/i.test(type),
      ),
    ).toEqual([]);
    const keys = Object.values(MUTATION_PERMISSIONS).flat();
    expect(
      keys.filter((key) =>
        /settlement|deposit|lexware|accounting|damage\.set_cost|missing_item\.set_cost/.test(key),
      ),
    ).toEqual([]);
  });

  it('147./149. Snapshot nach Transfer unveränderbar: ensure/rebuild ändert weder Snapshot noch Positionen, Hash bleibt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie, { cleanupMachines: [0] });
    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      { version: view.settlement.version },
    );
    expect(transfer.body.outcome).toBe('succeeded');
    const before = (
      await ctx.db
        .select()
        .from(accountingTransfers)
        .where(eq(accountingTransfers.settlementId, view.settlement.id))
    )[0]!;
    const linesBefore = await ctx.db
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, view.settlement.id));
    // Fakten „ändern“ sich nachträglich (Anzahlung) – die gesperrte Abrechnung bleibt unberührt.
    const advance = await post(
      ctx.app,
      cookie,
      `/staff/bookings/${world.bookingId}/advance-payments`,
      { amountCents: 500, receivedAt: '2026-10-01' },
    );
    expect(advance.status).toBe(409);
    const ensure = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/settlement/ensure`,
      headers: { cookie },
    });
    expect(ensure.statusCode).toBe(200);
    await settlementViewFor(ctx.app, cookie, world.processId);
    const after = (
      await ctx.db
        .select()
        .from(accountingTransfers)
        .where(eq(accountingTransfers.settlementId, view.settlement.id))
    )[0]!;
    const linesAfter = await ctx.db
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, view.settlement.id));
    expect(after.snapshotHash).toBe(before.snapshotHash);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(linesAfter).toEqual(linesBefore);
    const current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.version).toBe(ensure.json().settlement.version);
    expect(current.settlement.amountDueCents).toBe(15000);
  });
});
