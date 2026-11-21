/**
 * Phase 18 – Szenario G „Fehlende Berechtigungen“ (Order Szenario 7; Karte D §1.1/§2/§6).
 *
 * Serverseitige Negativmatrix: fehlt das Pflichtrecht, antwortet die API mit 403 FORBIDDEN
 * und es passiert NICHTS – keine Fachmutation, kein Job, keine Outbox-Mail, kein Dokument,
 * kein Security-Event, kein Fake-/Provider-Aufruf, kein Trainings-Ereignis. Jede Prüfung
 * läuft mit einem Mitarbeiter, der alle LESE-Voraussetzungen der Route besitzt
 * (`process.view_all`, `settlement.view`, `customer.view`, `calendar.view(_all)`, …), aber
 * genau das mutierende Recht nicht – damit entscheidet allein dieses Recht, nicht die
 * Sichtbarkeitsregel (404) oder ein fachlicher Blocker. Die Fixtures sind fachlich „bereit“
 * (Angebotsentwurf, freigabefähige AB, vorbereitete Übergabe, unterschriebene Rückgabe,
 * Abrechnungen in den passenden Zuständen, stornierbare Buchung, Tour, Zukunftspreis,
 * Rollen/Overrides); die Gegenprobe G-P zeigt, dass dieselben Aktionen mit Recht gelingen.
 *
 * Zusätzlich: Systemadmin-Semantik an Fachrouten (G-S: Katalogrechte ohne Rollenrecht,
 * Deny wirkungslos, Training-Gate bremst in production trotzdem – vgl. T111), CSRF-Legacy-
 * Pfad (G-C: `Sec-Fetch-Site: cross-site|same-site`, `Origin` ohne Sec-Fetch-Site gegen
 * leere Allowlist, `Origin: null`) und unauthentifizierte Aufrufe (G-U). Zum Schluss der
 * systemweite Integritätscheck (acceptance-integrity.ts) auf der Testdatenbank.
 *
 * Läuft gegen eine frische Testdatenbank (TEST_DATABASE_URL); der Zustand wird zu Beginn
 * vollständig zurückgesetzt, damit kein Test von Vorgängerdaten abhängt.
 */
import { randomUUID } from 'node:crypto';
import type { PermissionKey } from '@mietroyal/permissions';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrityViolations, tableCounts } from './acceptance-integrity.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { bookedProcess, cancelBooking, type BookedProcess } from './cancellation-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  productServiceFor,
  setPickupExactAddress,
} from './commerce-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { wipeDemoTestDatabase } from './demo-helpers.ts';
import { createEnvApp } from './env-app-helpers.ts';
import {
  DAYS,
  initializeAllInventory,
  readyHandover,
  scheduledBooking,
  type ScheduledBooking,
} from './handover-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import { POINT_MARKER, readyReturn, startedReturn } from './return-helpers.ts';
import {
  finalizedReturn,
  openClarifications,
  post,
  settlementViewFor,
} from './settlement-helpers.ts';
import { apiFor, createTour, pinMorningClockIfEvening, todayBerlin } from './tours-helpers.ts';
import {
  apiOn,
  definitionTitle,
  ensureTrainingDefinitions,
  expectTrainingRequired,
  FEATURE_DEFINITIONS,
  setRequirement,
} from './training-gate-helpers.ts';
import { inventoryServiceFor, machineByCode, productBySlug } from './warehouse-helpers.ts';

// ── Kontext ─────────────────────────────────────────────────────────────────

let ctx: TestContext;
let restoreClock: () => void = () => {};
let admin: { id: string };
let adminCookie: string;
/** Lesende Mitarbeiterin: alle Lese-Voraussetzungen der geprüften Routen, KEIN mutierendes Recht. */
let viewer: { user: { id: string }; cookie: string };

const READ_ONLY_KEYS: readonly PermissionKey[] = [
  'process.view_all',
  'settlement.view',
  'customer.view',
  'calendar.view',
  'calendar.view_all',
  'product.view',
  'machine.view',
  'return.view',
  'handover.view',
  'offer.view',
  'inquiry.view',
];

/** Rechte, die KEINE der geprüften Routen freischalten dürfen (Kontrolle gegen Tippfehler). */
const MUTATING_KEYS_UNDER_TEST: readonly PermissionKey[] = [
  'offer.send',
  'booking.confirm',
  'handover.perform',
  'return.complete',
  'machine.clean_complete',
  'settlement.release',
  'settlement.end_pre_notice_wait',
  'lexware.manual_transfer',
  'settlement.add_manual_charge',
  'deposit.record_advance',
  'deposit.record_security',
  'booking.cancel',
  'email.approve_prepared',
  'damage.document',
  'product.manage',
  'price.manage',
  'permission.manage',
  'machine.manage',
  'machine.block',
  'appointment.assign',
  'customer.create',
];

const FORBIDDEN_MESSAGE = 'Dafür fehlt dir die erforderliche Berechtigung.';
const TODAY_ISO = new Date().toISOString().slice(0, 10);

/**
 * Vollständiger Reset der Testdatenbank (Business-, Staff-, Job-, Demo-, Trainings- und
 * Offline-Tabellen) – der Helfer heißt „Demo“, truncatet aber generisch alle Fachtabellen.
 */
async function resetWorld(): Promise<void> {
  await wipeDemoTestDatabase(ctx.pool);
  await ctx.pool.query(
    'TRUNCATE training_feature_requirements, staff_training_clearances, offline_mutation_receipts, offline_access_leases CASCADE',
  );
  ctx.mailGateway.reset();
  ctx.push.reset();
  ctx.whatsapp.reset();
  ctx.accounting.calls.length = 0;
  ctx.accounting.failNext(0);
}

beforeAll(async () => {
  // Touren-Helfer (Tour mit heutigem Datum): abends Testuhr wie in den Touren-Suiten pinnen (tagsüber No-op).
  restoreClock = pinMorningClockIfEvening();
  ctx = await createTestContext();
  await resetWorld();
  admin = await bootstrapAdmin(ctx);
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
  viewer = await createStaffWithPermissions(ctx, admin.id, {
    firstName: 'Lena',
    lastName: 'Lesend',
    email: 'lena.lesend@test.example',
    password: 'lena-lesend-passwort-12345',
    permissionKeys: READ_ONLY_KEYS,
  });
  const effective = await ctx.auth.effectivePermissions(viewer.user.id);
  for (const key of MUTATING_KEYS_UNDER_TEST) expect(effective.has(key), key).toBe(false);
  for (const key of READ_ONLY_KEYS) expect(effective.has(key), key).toBe(true);
  await setPickupExactAddress(ctx, admin.id); // AB-Freigabe für Selbstabholung braucht die Adresse
  await initializeAllInventory(ctx, admin.id, 20);
});

afterAll(async () => {
  restoreClock();
  await destroyTestContext(ctx);
});

// ── Generischer Helfer: 403 OHNE Nebenwirkung ────────────────────────────────

/** Zähler, die bei JEDER abgelehnten Mutation unverändert bleiben müssen. */
const BASE_TABLES = [
  'integration_jobs',
  'mail_deliveries',
  'documents',
  'staff_security_events',
  'training_attempt_events',
] as const;

interface ForbiddenRequest {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: unknown;
  /** Default: Cookie der lesenden Mitarbeiterin. */
  cookie?: string | null;
  headers?: Record<string, string>;
}

interface ForbiddenCase {
  request: ForbiddenRequest;
  /** Routenspezifische Fachtabellen (zusätzlich zu BASE_TABLES). */
  tables?: readonly string[];
  /** Zeilenspezifische Zustandsprüfung (Status/Version/…) – Ergebnis muss vorher = nachher sein. */
  extra?: () => Promise<unknown>;
  /** Abweichendes dokumentiertes Fehlverhalten (CSRF, 401). Default 403 FORBIDDEN. */
  expected?: { status: number; code: string; message?: string };
}

interface SideEffectSnapshot {
  counts: Record<string, number>;
  fakes: Record<string, number>;
  extra: unknown;
}

async function snapshot(
  tables: readonly string[],
  extra: (() => Promise<unknown>) | undefined,
): Promise<SideEffectSnapshot> {
  return {
    counts: await tableCounts(ctx.pool, tables),
    fakes: {
      mailSent: ctx.mailGateway.sent.length,
      mailAttempts: ctx.mailGateway.attempts.length,
      staffMail: ctx.mail.sent.length,
      accountingCalls: ctx.accounting.calls.length,
      pushSent: ctx.push.sent.length,
      whatsappSend: ctx.whatsapp.sendCalls.length,
      whatsappMedia: ctx.whatsapp.mediaCalls.length,
    },
    extra: extra === undefined ? null : await extra(),
  };
}

/**
 * Führt die Mutation ohne das Pflichtrecht aus und beweist: definierter Fehler (Default
 * 403 FORBIDDEN mit neutralem Text, NUR ein `error`-Objekt) UND kein Nebeneffekt –
 * Tabellenzähler (Basis + routenspezifisch), Fake-Gateways (Mail/Push/WhatsApp/Mock-
 * Buchhaltung/Staff-Mail) und die zeilenspezifische Zustandsprüfung sind unverändert.
 */
async function expectForbiddenWithoutSideEffects(
  context: TestContext,
  input: ForbiddenCase,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const tables = [...new Set([...BASE_TABLES, ...(input.tables ?? [])])];
  const label = `${input.request.method} ${input.request.url}`;
  const before = await snapshot(tables, input.extra);
  const cookie = input.request.cookie === undefined ? viewer.cookie : input.request.cookie;
  const response = await context.app.inject({
    method: input.request.method,
    url: input.request.url,
    headers: {
      ...(cookie === null ? {} : { cookie }),
      ...(input.request.headers ?? {}),
    },
    ...(input.request.payload === undefined
      ? {}
      : { payload: input.request.payload as Record<string, unknown> }),
  });
  const expected = input.expected ?? { status: 403, code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const body = response.json() as {
    error?: { code?: string; message?: string; correlationId?: string };
  };
  expect(response.statusCode, `${label}: ${response.body}`).toBe(expected.status);
  expect(Object.keys(body), label).toEqual(['error']);
  expect(body.error?.code, label).toBe(expected.code);
  if (expected.message !== undefined) expect(body.error?.message, label).toBe(expected.message);
  expect(typeof body.error?.correlationId, label).toBe('string');
  const after = await snapshot(tables, input.extra);
  expect(after, `${label}: Nebenwirkung trotz Ablehnung`).toEqual(before);
  return { status: response.statusCode, body: body as Record<string, unknown> };
}

async function row<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> {
  const result = await ctx.pool.query<T>(sql, params);
  const first = result.rows[0];
  if (first === undefined) throw new Error(`Zeile fehlt: ${sql}`);
  return first;
}

async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return (await ctx.pool.query<T>(sql, params)).rows;
}

const settlementState = (settlementId: string) => () =>
  row(
    `SELECT status, version, notice_sent_at, wait_until, customer_response_received_at, released_at,
            locked_at, accounting_transfer_id, transferred_at
       FROM settlements WHERE id = $1`,
    [settlementId],
  );

const machineState = (machineId: string) => () =>
  row(`SELECT status, cleaning_since, cleaned_at, cleaned_by FROM machines WHERE id = $1`, [
    machineId,
  ]);

// ── G1–G5: Vermietung (Angebot, AB, Zahlungen, Storno) ───────────────────────

describe('P18-G: Vermietung – Angebot, Auftragsbestätigung, Zahlungen, Storno', () => {
  let offerVersionId: string;
  let booking: BookedProcess;
  let confirmationId: string;
  let cancelled: { processId: string; cancellationId: string };

  beforeAll(async () => {
    // Angebotsentwurf (versandfähig: Anfrage + TEST-Mietbedingungen vorhanden).
    const world = await createCommerceWorld(ctx, admin.id);
    ({ versionId: offerVersionId } = await commerceServices(ctx).offers.createOffer(
      admin.id,
      world.processId,
    ));
    // Bestätigte Buchung mit vorbereiteter AB (Abholadresse ist gesetzt ⇒ freigabefähig).
    booking = await bookedProcess(ctx, admin.id, { eventInDays: 12 });
    confirmationId = (
      await row<{ id: string }>(`SELECT id FROM order_confirmations WHERE booking_id = $1`, [
        booking.bookingId,
      ])
    ).id;
    // Stornierte Buchung mit vorbereiteter Bestätigung (Versand erfordert email.approve_prepared).
    const second = await bookedProcess(ctx, admin.id, { eventInDays: 20 });
    const view = await cancelBooking(ctx, admin.id, second.processId);
    cancelled = { processId: second.processId, cancellationId: view.id };
  });

  it('P18-G1. Angebot versenden ohne offer.send ⇒ 403; Version bleibt Entwurf, kein Token, kein PDF, keine Outbox-Mail, kein Job', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: { method: 'POST', url: `/staff/offer-versions/${offerVersionId}/send` },
      tables: ['offer_versions', 'offer_access_tokens', 'offer_deliveries', 'bookings'],
      extra: () =>
        row(
          `SELECT status, sent_at, sent_by, customer_snapshot FROM offer_versions WHERE id = $1`,
          [offerVersionId],
        ),
    });
    expect(
      (
        await row<{ status: string }>(`SELECT status FROM offer_versions WHERE id = $1`, [
          offerVersionId,
        ])
      ).status,
    ).toBe('draft');
  });

  it('P18-G2. AB freigeben und versenden ohne booking.confirm ⇒ 403; AB bleibt „prepared“ ohne Dokument und ohne Outbox-Mail', async () => {
    const state = () =>
      row(
        `SELECT status, document_id, approved_at, approved_by, mail_delivery_id FROM order_confirmations WHERE id = $1`,
        [confirmationId],
      );
    await expectForbiddenWithoutSideEffects(ctx, {
      request: { method: 'POST', url: `/staff/order-confirmations/${confirmationId}/approve` },
      tables: ['order_confirmations'],
      extra: state,
    });
    await expectForbiddenWithoutSideEffects(ctx, {
      request: { method: 'POST', url: `/staff/order-confirmations/${confirmationId}/send` },
      tables: ['order_confirmations'],
      extra: state,
    });
    expect((await state()).status).toBe('prepared');
  });

  it('P18-G3. Anzahlung/Kaution erfassen ohne deposit.record_advance / deposit.record_security ⇒ 403; keine Zahlungszeilen', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/bookings/${booking.bookingId}/advance-payments`,
        payload: { amountCents: 5000, receivedAt: TODAY_ISO },
      },
      tables: ['booking_advance_payments', 'booking_security_deposits'],
    });
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/bookings/${booking.bookingId}/security-deposits`,
        payload: { amountCents: 10000, receivedAt: TODAY_ISO },
      },
      tables: ['booking_advance_payments', 'booking_security_deposits'],
    });
    expect(
      await tableCounts(ctx.pool, ['booking_advance_payments', 'booking_security_deposits']),
    ).toEqual({ booking_advance_payments: 0, booking_security_deposits: 0 });
  });

  it('P18-G4. Storno ohne booking.cancel ⇒ 403; Vorgang offen, Termine geplant, keine Storno-Zeile, kein Transfer-Job, keine Mail', async () => {
    const state = async () => ({
      process: await row(`SELECT main_status, cancelled_at FROM processes WHERE id = $1`, [
        booking.processId,
      ]),
      appointments: await rows(
        `SELECT kind, status, version FROM appointments WHERE booking_id = $1 ORDER BY kind`,
        [booking.bookingId],
      ),
      assignments: await rows(
        `SELECT slot_no, status, machine_id FROM machine_assignments WHERE booking_id = $1 ORDER BY slot_no`,
        [booking.bookingId],
      ),
    });
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/processes/${booking.processId}/cancellation`,
        payload: { confirm: true },
      },
      tables: ['cancellations', 'accounting_transfers', 'process_relations'],
      extra: state,
    });
    const after = await state();
    expect(after.process).toMatchObject({ main_status: 'open', cancelled_at: null });
    expect(after.appointments.map((a) => a.status)).toEqual(['scheduled', 'scheduled']);
  });

  it('P18-G5. Stornobestätigung senden / Stornokosten übertragen ohne email.approve_prepared bzw. lexware.manual_transfer ⇒ 403; Bestätigung bleibt „prepared“, kein Mock-Aufruf', async () => {
    const state = () =>
      row(
        `SELECT confirmation_status, confirmation_sent_at, confirmation_mail_delivery_id, finance_status, accounting_transfer_id
           FROM cancellations WHERE id = $1`,
        [cancelled.cancellationId],
      );
    expect((await state()).confirmation_status).toBe('prepared');
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/cancellations/${cancelled.cancellationId}/confirmation/send`,
        payload: {},
      },
      tables: ['cancellations'],
      extra: state,
    });
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/cancellations/${cancelled.cancellationId}/transfer`,
        payload: {},
      },
      tables: ['cancellations', 'accounting_transfers'],
      extra: state,
    });
  });
});

// ── G6–G8: Übergabe, Schaden, Rückgabe ──────────────────────────────────────

describe('P18-G: Übergabe, Schaden, Rückgabe', () => {
  let handover: ScheduledBooking & { machineId: string };
  let ret: { bookingId: string; returnMachineId: string; machineId: string };

  beforeAll(async () => {
    // Übergabe bis unmittelbar vor die Finalisierung (zugewiesen, vorbereitet, geprüft, Foto, Unterschriften).
    const booking = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, booking.bookingId, ['MR-10-01-02']);
    handover = { ...booking, machineId: (await machineByCode(ctx.db, 'MR-10-01-02')).id };
    // Ausgegebene Buchung, Rückgabe gestartet und bis vor die Finalisierung gebracht.
    const started = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-03'],
      skipInventoryInit: true,
    });
    const detail = await readyReturn(ctx, admin.id, started.services, started.world.bookingId);
    expect(detail.blockers).toEqual([]);
    ret = {
      bookingId: started.world.bookingId,
      returnMachineId: detail.machines[0]!.id,
      machineId: (await machineByCode(ctx.db, 'MR-10-01-03')).id,
    };
  });

  it('P18-G6. Übergabe finalisieren ohne handover.perform ⇒ 403; keine Lagerausgabe, kein Lieferschein/Protokoll, Maschine bleibt reserviert', async () => {
    const state = async () => ({
      handover: await row(
        `SELECT status, finalized_at, finalized_by, protocol_document_id FROM handovers WHERE booking_id = $1`,
        [handover.bookingId],
      ),
      assignments: await rows(
        `SELECT slot_no, status FROM machine_assignments WHERE booking_id = $1 ORDER BY slot_no`,
        [handover.bookingId],
      ),
      machine: await machineState(handover.machineId)(),
      deliveryNote: await row(
        `SELECT status, document_id FROM delivery_notes WHERE booking_id = $1`,
        [handover.bookingId],
      ),
    });
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/handover/${handover.bookingId}/finalize`,
        payload: {},
      },
      tables: ['inventory_movements', 'delivery_packets', 'handovers', 'delivery_notes'],
      extra: state,
    });
    const after = await state();
    expect(after.machine.status).toBe('reserved');
    expect(after.assignments.map((a) => a.status)).toEqual(['prepared']);
    expect(after.handover.finalized_at).toBeNull();
  });

  it('P18-G7. Schaden dokumentieren ohne damage.document ⇒ 403; keine Schadens-/Markierungszeile', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/returns/${ret.bookingId}/machines/${ret.returnMachineId}/damages`,
        payload: { severity: 'medium', description: 'Riss im Deckel', markers: [POINT_MARKER] },
      },
      tables: ['machine_damages', 'damage_markers', 'damage_photos', 'settlement_clarifications'],
    });
    expect(await tableCounts(ctx.pool, ['machine_damages'])).toEqual({ machine_damages: 0 });
  });

  it('P18-G8. Rückgabe finalisieren ohne return.complete ⇒ 403; keine Lagerrücknahme, kein Protokoll, keine Abrechnung, Maschine bleibt vermietet', async () => {
    const state = async () => ({
      ret: await row(
        `SELECT status, finalized_at, protocol_document_id, actual_return_at FROM rental_returns WHERE booking_id = $1`,
        [ret.bookingId],
      ),
      assignments: await rows(
        `SELECT slot_no, status FROM machine_assignments WHERE booking_id = $1 ORDER BY slot_no`,
        [ret.bookingId],
      ),
      machine: await machineState(ret.machineId)(),
    });
    await expectForbiddenWithoutSideEffects(ctx, {
      request: { method: 'POST', url: `/staff/returns/${ret.bookingId}/finalize` },
      tables: ['inventory_movements', 'rental_returns', 'settlements', 'delivery_packets'],
      extra: state,
    });
    const after = await state();
    expect(after.machine.status).toBe('rented');
    expect(after.assignments.map((a) => a.status)).toEqual(['issued']);
    expect(after.ret.finalized_at).toBeNull();
  });
});

// ── G9–G13: Abrechnung, Buchhaltung, Reinigung ──────────────────────────────

describe('P18-G: Abrechnung, Buchhaltung, Reinigung', () => {
  /** Schaden berechnet, Kundeninformation noch nicht versendet (customer_notice_required). */
  let noticePending: { settlementId: string; version: number };
  /** Kundeninformation versendet, Frist läuft (customer_waiting). */
  let waiting: { settlementId: string; version: number };
  /** Ohne Beanstandung: bereit zur Buchhaltung (ready_for_accounting). */
  let ready: { settlementId: string; version: number; machineId: string };

  async function chargedDamageSettlement(machineCode: string) {
    const world = await finalizedReturn(ctx, admin.id, adminCookie, {
      machineCodes: [machineCode],
      damages: [{ description: 'Riss im Deckel', severity: 'light' }],
    });
    const view = await settlementViewFor(ctx.app, adminCookie, world.processId);
    const clarification = openClarifications(view, 'damage_cost')[0]!;
    const decided = await post(
      ctx.app,
      adminCookie,
      `/staff/settlements/${view.settlement.id}/clarifications/${clarification.id}/resolve`,
      { decision: 'charge', amountCents: 5000, version: view.settlement.version },
    );
    expect(decided.status).toBe(200);
    const current = await settlementViewFor(ctx.app, adminCookie, world.processId);
    expect(current.settlement.status).toBe('customer_notice_required');
    return { world, settlementId: current.settlement.id, version: current.settlement.version };
  }

  beforeAll(async () => {
    const first = await chargedDamageSettlement('MR-10-01-04');
    noticePending = { settlementId: first.settlementId, version: first.version };

    const second = await chargedDamageSettlement('MR-10-01-05');
    const sent = await post(
      ctx.app,
      adminCookie,
      `/staff/settlements/${second.settlementId}/notice/approve-and-send`,
      { version: second.version },
    );
    expect(sent.status).toBe(200);
    // Frist beginnt erst mit bestätigtem Mailversand (nur Mail-Jobs, keine Transfer-Jobs).
    await settleMailJobs(ctx);
    const waitingView = await settlementViewFor(ctx.app, adminCookie, second.world.processId);
    expect(waitingView.settlement.status).toBe('customer_waiting');
    waiting = { settlementId: waitingView.settlement.id, version: waitingView.settlement.version };

    const third = await finalizedReturn(ctx, admin.id, adminCookie, {
      machineCodes: ['MR-10-01-06'],
    });
    const readyView = await settlementViewFor(ctx.app, adminCookie, third.processId);
    expect(readyView.settlement.status).toBe('ready_for_accounting');
    ready = {
      settlementId: readyView.settlement.id,
      version: readyView.settlement.version,
      machineId: (await machineByCode(ctx.db, 'MR-10-01-06')).id,
    };
  });

  it('P18-G9. Manuelle Position ohne settlement.add_manual_charge ⇒ 403; keine Position, Version unverändert', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/settlements/${noticePending.settlementId}/lines`,
        payload: {
          type: 'manual_charge',
          description: 'Fremder Zuschlag',
          amountCents: 999,
          version: noticePending.version,
        },
      },
      tables: ['settlement_lines'],
      extra: settlementState(noticePending.settlementId),
    });
  });

  it('P18-G10. Kundeninformation freigeben+senden ohne settlement.release ⇒ 403; keine Notice-Zeile, keine Outbox-Mail, kein Job, Status/Version unverändert', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/settlements/${noticePending.settlementId}/notice/approve-and-send`,
        payload: { version: noticePending.version },
      },
      tables: ['settlement_customer_notices', 'settlement_lines'],
      extra: settlementState(noticePending.settlementId),
    });
    const after = await settlementState(noticePending.settlementId)();
    expect(after).toMatchObject({ status: 'customer_notice_required', notice_sent_at: null });
  });

  it('P18-G11. Kundenrückmeldung / „wie berechnet freigeben“ ohne settlement.release und Frist beenden ohne settlement.end_pre_notice_wait ⇒ 403; Frist läuft unverändert weiter, kein Transfer-Job verändert', async () => {
    const before = await settlementState(waiting.settlementId)();
    expect(before).toMatchObject({ status: 'customer_waiting', released_at: null });
    const transferJobs = () =>
      rows(
        `SELECT status, run_at FROM integration_jobs
          WHERE type = 'settlement.accounting_transfer' AND payload->>'settlementId' = $1 ORDER BY created_at`,
        [waiting.settlementId],
      );
    const extra = async () => ({
      settlement: await settlementState(waiting.settlementId)(),
      jobs: await transferJobs(),
      clarifications: await rows(
        `SELECT type, status FROM settlement_clarifications WHERE settlement_id = $1 ORDER BY created_at`,
        [waiting.settlementId],
      ),
    });
    for (const path of ['customer-response', 'release', 'end-wait']) {
      await expectForbiddenWithoutSideEffects(ctx, {
        request: {
          method: 'POST',
          url: `/staff/settlements/${waiting.settlementId}/${path}`,
          payload: { version: waiting.version },
        },
        tables: [
          'settlement_clarifications',
          'settlement_customer_notices',
          'accounting_transfers',
        ],
        extra,
      });
    }
    expect(await settlementState(waiting.settlementId)()).toEqual(before);
  });

  it('P18-G12. Manuelle Buchhaltungsübertragung ohne lexware.manual_transfer ⇒ 403; kein Mock-Aufruf, kein Transfer, Abrechnung nicht gesperrt', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/settlements/${ready.settlementId}/transfer`,
        payload: { version: ready.version },
      },
      tables: ['accounting_transfers', 'lexware_invoice_mappings'],
      extra: settlementState(ready.settlementId),
    });
    const after = await settlementState(ready.settlementId)();
    expect(after).toMatchObject({
      status: 'ready_for_accounting',
      locked_at: null,
      accounting_transfer_id: null,
    });
    expect(ctx.accounting.calls).toHaveLength(0);
  });

  it('P18-G13. Reinigung abschließen ohne machine.clean_complete ⇒ 403; Maschine bleibt in Reinigung, kein Gutschein-Prüfjob, kein Trainings-Ereignis', async () => {
    expect((await machineState(ready.machineId)()).status).toBe('cleaning');
    await expectForbiddenWithoutSideEffects(ctx, {
      request: { method: 'POST', url: `/staff/machines/${ready.machineId}/clean-complete` },
      tables: ['machines', 'vouchers'],
      extra: machineState(ready.machineId),
    });
    expect(await machineState(ready.machineId)()).toMatchObject({
      status: 'cleaning',
      cleaned_at: null,
    });
  });
});

// ── G14–G16: Preise/Produkte, Lager, Kunden ─────────────────────────────────

describe('P18-G: Preise/Produkte, Lager, Kunden', () => {
  let productId: string;
  let futurePriceId: string;
  let spareMachineId: string;
  let customerId: string;

  beforeAll(async () => {
    const product = await productBySlug(ctx.db, 'slush-1x10');
    productId = product.id;
    await productServiceFor(ctx).planFuturePrice(
      admin.id,
      productId,
      8000,
      new Date(Date.now() + 60 * DAYS),
    );
    futurePriceId = (
      await row<{ id: string }>(
        `SELECT id FROM product_prices WHERE product_id = $1 AND effective_from > now() ORDER BY effective_from DESC LIMIT 1`,
        [productId],
      )
    ).id;
    spareMachineId = (await machineByCode(ctx.db, 'MR-10-01-01')).id;
    customerId = (
      await row<{ customer_id: string }>(
        `SELECT customer_id FROM processes ORDER BY created_at LIMIT 1`,
        [],
      )
    ).customer_id;
  });

  it('P18-G14. Produkt-/Preisrouten (8) ohne product.manage bzw. price.manage ⇒ 403; products/product_prices unverändert (Preis-Single-Source)', async () => {
    const state = async () => ({
      product: await row(`SELECT name, active, sale_unit FROM products WHERE id = $1`, [productId]),
      prices: await rows(
        `SELECT price_cents, effective_from FROM product_prices WHERE product_id = $1 ORDER BY effective_from`,
        [productId],
      ),
    });
    const cases: ForbiddenRequest[] = [
      {
        method: 'POST',
        url: '/staff/products',
        payload: {
          slug: 'p18-fremdprodukt',
          name: 'Fremdprodukt',
          category: 'consumable',
          saleUnit: 'Stück',
          initialPriceCents: 100,
        },
      },
      { method: 'PATCH', url: `/staff/products/${productId}`, payload: { name: 'Manipuliert' } },
      { method: 'POST', url: `/staff/products/${productId}/active`, payload: { active: false } },
      { method: 'POST', url: `/staff/products/${productId}/price`, payload: { priceCents: 1 } },
      {
        method: 'POST',
        url: `/staff/products/${productId}/future-price`,
        payload: { priceCents: 1, effectiveFrom: new Date(Date.now() + 90 * DAYS).toISOString() },
      },
      {
        method: 'PATCH',
        url: `/staff/product-prices/${futurePriceId}`,
        payload: { priceCents: 1 },
      },
      { method: 'DELETE', url: `/staff/product-prices/${futurePriceId}` },
    ];
    for (const request of cases) {
      await expectForbiddenWithoutSideEffects(ctx, {
        request,
        tables: ['products', 'product_prices'],
        extra: state,
      });
    }
    const after = await state();
    expect(after.product).toMatchObject({ name: '1×10 L', active: true });
    expect(after.prices.map((p) => Number(p.price_cents))).toEqual([7500, 8000]);
  });

  it('P18-G15. Maschine anlegen / sperren ohne machine.manage bzw. machine.block ⇒ 403; keine Maschine, keine Sperre, keine Risikohinweise', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: { method: 'POST', url: '/staff/machines', payload: { productId } },
      tables: ['machines', 'machine_blocks', 'machine_risk_incidents'],
    });
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/machines/${spareMachineId}/blocks`,
        payload: {
          startsAt: new Date(Date.now() + 1 * DAYS).toISOString(),
          endsAt: new Date(Date.now() + 2 * DAYS).toISOString(),
          reason: 'Fremde Sperre',
        },
      },
      tables: ['machines', 'machine_blocks', 'machine_risk_incidents'],
      extra: machineState(spareMachineId),
    });
    expect(await tableCounts(ctx.pool, ['machine_blocks'])).toEqual({ machine_blocks: 0 });
  });

  it('P18-G16. Gutschein senden ohne email.approve_prepared ⇒ 403 (Rechteprüfung VOR dem Laden – kein Gutschein nötig); kein voucher.delivery-Job', async () => {
    await expectForbiddenWithoutSideEffects(ctx, {
      request: {
        method: 'POST',
        url: `/staff/customers/${customerId}/send-voucher`,
        payload: { voucherId: randomUUID() },
      },
      tables: ['vouchers', 'customers'],
    });
    expect(
      await rows(`SELECT id FROM integration_jobs WHERE type LIKE 'voucher.%'`, []),
    ).toHaveLength(0);
  });
});

// ── G17: Admin (Rollen, Rechte, Overrides, Erklärtexte) ─────────────────────

describe('P18-G: Rechteverwaltung', () => {
  let targetRoleId: string;
  let ottoId: string;
  let overrideId: string;
  let systemRoleId: string;

  beforeAll(async () => {
    targetRoleId = await ctx.admin.createRole(admin.id, {
      name: 'Zielrolle P18',
      permissionKeys: ['customer.view'],
    });
    const otto = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Otto',
      lastName: 'Opfer',
      email: 'otto.opfer@test.example',
      password: 'otto-opfer-passwort-12345',
    });
    ottoId = otto.id;
    await ctx.admin.setUserRoles(admin.id, ottoId, [targetRoleId]);
    overrideId = await ctx.admin.addOverride(admin.id, ottoId, {
      permissionKey: 'offer.view',
      effect: 'allow',
    });
    systemRoleId = (await ctx.admin.listRoles()).find((role) => role.isSystemAdmin)!.id;
  });

  it('P18-G17. Rollen ändern/löschen, Rollen zuweisen (auch Selbst-Eskalation zur Systemrolle), Override entfernen/anlegen, Erklärtext ändern ohne permission.manage ⇒ 403; Rechte-Tabellen unverändert, KEIN Security-Event', async () => {
    const state = async () => ({
      role: await row(`SELECT name, is_system_admin FROM staff_roles WHERE id = $1`, [
        targetRoleId,
      ]),
      rolePermissions: await rows(
        `SELECT permission_key FROM staff_role_permissions WHERE role_id = $1 ORDER BY permission_key`,
        [targetRoleId],
      ),
      ottoRoles: await rows(
        `SELECT role_id FROM staff_user_roles WHERE user_id = $1 ORDER BY role_id`,
        [ottoId],
      ),
      viewerRoles: await rows(
        `SELECT role_id FROM staff_user_roles WHERE user_id = $1 ORDER BY role_id`,
        [viewer.user.id],
      ),
      override: await rows(
        `SELECT permission_key, effect FROM staff_user_permission_overrides WHERE id = $1`,
        [overrideId],
      ),
      viewerEffective: [...(await ctx.auth.effectivePermissions(viewer.user.id))].sort(),
    });
    const cases: ForbiddenRequest[] = [
      {
        method: 'PATCH',
        url: `/staff/roles/${targetRoleId}`,
        payload: { name: 'Root', permissionKeys: ['permission.manage'] },
      },
      { method: 'DELETE', url: `/staff/roles/${targetRoleId}` },
      { method: 'POST', url: `/staff/users/${ottoId}/roles`, payload: { roleIds: [] } },
      // Adversarial H (Rechteumgehung): Selbst-Ernennung zur Systemrolle.
      {
        method: 'POST',
        url: `/staff/users/${viewer.user.id}/roles`,
        payload: { roleIds: [systemRoleId] },
      },
      {
        method: 'POST',
        url: `/staff/users/${viewer.user.id}/overrides`,
        payload: { permissionKey: 'permission.manage', effect: 'allow' },
      },
      { method: 'DELETE', url: `/staff/overrides/${overrideId}` },
      {
        method: 'PUT',
        url: '/staff/permissions/customer.view/explanation',
        payload: { explanation: 'Manipulierter Text' },
      },
    ];
    for (const request of cases) {
      await expectForbiddenWithoutSideEffects(ctx, {
        request,
        tables: [
          'staff_roles',
          'staff_role_permissions',
          'staff_user_roles',
          'staff_user_permission_overrides',
          'staff_permission_explanations',
        ],
        extra: state,
      });
    }
    const after = await state();
    expect(after.role).toMatchObject({ name: 'Zielrolle P18', is_system_admin: false });
    expect(after.override).toHaveLength(1);
    expect(await ctx.auth.isSystemAdmin(viewer.user.id)).toBe(false);
  });
});

// ── G18: Tour-Übernahme ─────────────────────────────────────────────────────

describe('P18-G: Touren', () => {
  let tourId: string;

  beforeAll(async () => {
    const tour = await createTour(apiFor(ctx.app, adminCookie), {
      tourDate: todayBerlin(),
      assignedUserId: admin.id,
    });
    tourId = tour.id as string;
  });

  it('P18-G18. Tour übernehmen ohne appointment.assign ⇒ 403 (Tour ist mit calendar.view_all sichtbar); Zuständigkeit/Version unverändert', async () => {
    const state = () =>
      row(`SELECT assigned_user_id, status, version FROM tours WHERE id = $1`, [tourId]);
    await expectForbiddenWithoutSideEffects(ctx, {
      request: { method: 'POST', url: `/staff/tours/${tourId}/takeover`, payload: {} },
      tables: ['tours', 'tour_stops', 'appointments'],
      extra: state,
    });
    expect(await state()).toMatchObject({ assigned_user_id: admin.id, status: 'draft' });
  });
});

// ── G-S: Systemadmin-Semantik ───────────────────────────────────────────────

describe('P18-G: Systemadmin-Semantik (G-S)', () => {
  let prod: FastifyInstance;
  let sysadmin: { id: string; cookie: string };

  beforeAll(async () => {
    const user = await createEmployeeWithPassword(ctx, admin.id, {
      firstName: 'Sascha',
      lastName: 'System',
      email: 'sascha.system@test.example',
      password: 'sascha-system-passwort-12345',
    });
    const systemRoleId = (await ctx.admin.listRoles()).find((role) => role.isSystemAdmin)!.id;
    await ctx.admin.setUserRoles(admin.id, user.id, [systemRoleId]);
    // Deny-Overrides sind speicherbar, für Systemadmins aber wirkungslos (system-admin 4.).
    for (const key of ['customer.create', 'product.manage'] as const) {
      await ctx.admin.addOverride(admin.id, user.id, { permissionKey: key, effect: 'deny' });
    }
    sysadmin = {
      id: user.id,
      cookie: (await login(ctx.app, 'sascha.system@test.example', 'sascha-system-passwort-12345'))
        .cookie,
    };
    prod = await createEnvApp(ctx, 'production');
  });

  afterAll(async () => {
    await prod.close();
  });

  it('P18-G19. Systemadmin ohne explizites Rollenrecht passiert Fachrouten (Kunde anlegen, Produkt anlegen) – ein Deny-Override ist wirkungslos', async () => {
    expect(await ctx.auth.isSystemAdmin(sysadmin.id)).toBe(true);
    const api = apiOn(ctx.app, sysadmin.cookie);
    const customer = await api('POST', '/staff/customers', {
      type: 'private',
      firstName: 'Sina',
      lastName: 'Systemkundin',
    });
    expect(customer.status, JSON.stringify(customer.body)).toBe(200);
    expect(customer.body.customer.id).toEqual(expect.any(String));
    const product = await api('POST', '/staff/products', {
      slug: 'p18-sysadmin-produkt',
      name: 'P18 Systemadmin-Produkt',
      category: 'consumable',
      saleUnit: 'Stück',
      initialPriceCents: 150,
    });
    expect(product.status, JSON.stringify(product.body)).toBe(200);
    expect(product.body.product.slug).toBe('p18-sysadmin-produkt');
  });

  it('P18-G20. Training-Gate bremst den Systemadmin in production trotzdem (TRAINING_REQUIRED, Inventur bleibt offen); development erzwingt nicht (vgl. T108/T111)', async () => {
    await ensureTrainingDefinitions(ctx.db);
    const feature = 'inventory.stocktake_approve';
    const definition = FEATURE_DEFINITIONS[feature]!;
    await setRequirement(ctx.db, feature, definition, true, admin.id);
    const inventory = inventoryServiceFor(ctx);
    const item = (await inventory.listItems())[0]!;
    const stocktake = await inventory.createStocktake(sysadmin.id, [
      { itemId: item.itemId, countedStock: 7 },
    ]);
    expect(stocktake.status).toBe('pending_approval');
    const url = `/staff/inventory/stocktakes/${stocktake.id}/approve`;
    const before = await tableCounts(ctx.pool, ['inventory_movements', 'staff_security_events']);
    expectTrainingRequired(
      await apiOn(prod, sysadmin.cookie)('POST', url),
      feature,
      await definitionTitle(ctx.db, definition),
    );
    expect(
      (
        await row<{ status: string }>(`SELECT status FROM inventory_stocktakes WHERE id = $1`, [
          stocktake.id,
        ])
      ).status,
    ).toBe('pending_approval');
    expect(await tableCounts(ctx.pool, ['inventory_movements', 'staff_security_events'])).toEqual(
      before,
    );
    // Dieselbe Aktion in development: Gate nicht erzwungen ⇒ Freigabe gelingt.
    const dev = await apiOn(ctx.app, sysadmin.cookie)('POST', url);
    expect(dev.status, JSON.stringify(dev.body)).toBe(200);
    expect(dev.body.stocktake.status).toBe('approved');
    await setRequirement(ctx.db, feature, definition, false, admin.id);
  });
});

// ── G-C: CSRF-Legacy-Pfad ───────────────────────────────────────────────────

describe('P18-G: CSRF (G-C)', () => {
  it('P18-G21. Staff-Mutation aus fremdem Kontext: Sec-Fetch-Site cross-site/same-site, Origin ohne Sec-Fetch-Site (leere Allowlist) und Origin: null ⇒ 403 CSRF_REJECTED – kein Kunde angelegt, kein Security-Event', async () => {
    expect(ctx.config.auth.allowedOrigins).toEqual([]);
    const payload = { type: 'private', firstName: 'Carla', lastName: 'Crosssite' };
    const headerSets: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site', origin: 'http://localhost:3011' },
      { origin: 'https://evil.example' },
      { origin: 'null' },
    ];
    for (const headers of headerSets) {
      await expectForbiddenWithoutSideEffects(ctx, {
        request: {
          method: 'POST',
          url: '/staff/customers',
          payload,
          cookie: adminCookie,
          headers,
        },
        tables: ['customers'],
        expected: {
          status: 403,
          code: 'CSRF_REJECTED',
          message: 'Anfrage aus fremdem Kontext abgelehnt.',
        },
      });
    }
    expect(await rows(`SELECT id FROM customers WHERE last_name = 'Crosssite'`, [])).toHaveLength(
      0,
    );
  });
});

// ── G-U: ohne Anmeldung ─────────────────────────────────────────────────────

describe('P18-G: ohne Anmeldung (G-U)', () => {
  it('P18-G22. Angebot senden, Abrechnung freigeben, Rolle ändern ohne Cookie (und mit ungültigem Cookie) ⇒ 401 UNAUTHENTICATED – keine Mutation', async () => {
    const version = await row<{ id: string }>(
      `SELECT id FROM offer_versions WHERE status = 'draft' ORDER BY created_at LIMIT 1`,
      [],
    );
    const settlement = await row<{ id: string; version: number }>(
      `SELECT id, version FROM settlements ORDER BY created_at LIMIT 1`,
      [],
    );
    const role = await row<{ id: string }>(
      `SELECT id FROM staff_roles WHERE is_system_admin = false ORDER BY created_at LIMIT 1`,
      [],
    );
    const requests: ForbiddenRequest[] = [
      { method: 'POST', url: `/staff/offer-versions/${version.id}/send` },
      {
        method: 'POST',
        url: `/staff/settlements/${settlement.id}/release`,
        payload: { version: settlement.version },
      },
      { method: 'PATCH', url: `/staff/roles/${role.id}`, payload: { name: 'Root' } },
    ];
    for (const cookie of [null, 'mr_staff_session=ungueltiger-token']) {
      for (const request of requests) {
        await expectForbiddenWithoutSideEffects(ctx, {
          request: { ...request, cookie },
          tables: ['offer_versions', 'settlements', 'staff_roles', 'staff_sessions'],
          extra: async () => ({
            version: await row(`SELECT status FROM offer_versions WHERE id = $1`, [version.id]),
            settlement: await settlementState(settlement.id)(),
            role: await row(`SELECT name FROM staff_roles WHERE id = $1`, [role.id]),
          }),
          expected: { status: 401, code: 'UNAUTHENTICATED', message: 'Bitte anmelden.' },
        });
      }
    }
  });
});

// ── G-P: Gegenprobe + Integrität ────────────────────────────────────────────

describe('P18-G: Gegenprobe und Integrität', () => {
  it('P18-G23. Gegenprobe: mit Recht gelingen dieselben Aktionen (Angebot senden, AB freigeben, Zukunftspreis ändern, Same-Origin-Kunde) – die Fixtures waren fachlich bereit', async () => {
    const api = apiOn(ctx.app, adminCookie);
    const version = await row<{ id: string }>(
      `SELECT id FROM offer_versions WHERE status = 'draft' ORDER BY created_at LIMIT 1`,
      [],
    );
    const before = await tableCounts(ctx.pool, [
      'documents',
      'mail_deliveries',
      'offer_access_tokens',
    ]);
    const sent = await api('POST', `/staff/offer-versions/${version.id}/send`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.sent).toBe(true);
    const after = await tableCounts(ctx.pool, [
      'documents',
      'mail_deliveries',
      'offer_access_tokens',
    ]);
    expect(after.documents).toBe(before.documents! + 1);
    expect(after.mail_deliveries).toBe(before.mail_deliveries! + 1);
    expect(after.offer_access_tokens).toBe(before.offer_access_tokens! + 1);

    const confirmation = await row<{ id: string }>(
      `SELECT id FROM order_confirmations WHERE status = 'prepared' ORDER BY created_at LIMIT 1`,
      [],
    );
    const approved = await api('POST', `/staff/order-confirmations/${confirmation.id}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      await row(`SELECT status, document_id FROM order_confirmations WHERE id = $1`, [
        confirmation.id,
      ]),
    ).toMatchObject({ status: 'approved', document_id: expect.any(String) });

    const futurePrice = await row<{ id: string }>(
      `SELECT id FROM product_prices WHERE effective_from > now() ORDER BY effective_from DESC LIMIT 1`,
      [],
    );
    const patched = await api('PATCH', `/staff/product-prices/${futurePrice.id}`, {
      priceCents: 8500,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(
      Number(
        (
          await row<{ price_cents: string }>(
            `SELECT price_cents FROM product_prices WHERE id = $1`,
            [futurePrice.id],
          )
        ).price_cents,
      ),
    ).toBe(8500);

    // Same-Origin passiert den CSRF-Hook (Gegenprobe zu G21).
    const sameOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/staff/customers',
      headers: { cookie: adminCookie, 'sec-fetch-site': 'same-origin' },
      payload: { type: 'private', firstName: 'Sonja', lastName: 'Sameorigin' },
    });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it('P18-G24. Keine der Ablehnungen hat ein Security-Event vorgetäuscht; Datenbank ist nach dem Szenario konsistent (Integritätscheck 0 Verletzungen)', async () => {
    // Es gibt keinen Ablehnungs-Audittyp (Karte D §2); die Events stammen ausschließlich aus
    // den erfolgreichen Admin-Aktionen des Setups (Mitarbeiter/Rollen/Overrides/Sessions).
    const types = await rows<{ type: string }>(
      `SELECT DISTINCT type FROM staff_security_events ORDER BY type`,
      [],
    );
    for (const { type } of types) expect(type).not.toMatch(/denied|forbidden|rejected/i);
    expect(await integrityViolations(ctx.pool)).toEqual([]);
  });
});
