import {
  appointments,
  conversationMessages,
  customers,
  inquiries,
  inventoryMovements,
  machineAssignments,
  machineBlocks,
  machines,
  mailDeliveries,
  offerVersions,
  processes,
  rentalReturns,
  settlements,
  tours,
  tourStops,
  handovers,
  bookingPickupRepresentatives,
} from '@mietroyal/database';
import { berlinDateOf, berlinDateTimeToUtc, offerExpiresAt } from '@mietroyal/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_DATASET_VERSION } from '../src/demo/dataset.ts';
import {
  DEMO_CUSTOMERS,
  DEMO_MACHINE_BLOCK_REASON,
  DEMO_MACHINES,
  DEMO_MAIL_EXERCISE_CUSTOMERS,
  DEMO_SEED_KEYS,
  demoCustomerEmail,
  demoWhitelistDomain,
  REQUIRED_DEMO_SEED_KEYS,
} from '../src/demo/seed/data.ts';
import { berlinDayShift } from '../src/demo/seed/time.ts';
import {
  DemoSeedService,
  findFirstActiveSystemAdmin,
  resolveDemoSeedActor,
} from '../src/demo/seed/seed-service.ts';
import { DemoError, DEMO_MESSAGES } from '../src/demo/types.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  createDemoTestContext,
  demoServicesFor,
  demoTestNow,
  freshDemoDatabase,
  type DemoTestServices,
} from './demo-helpers.ts';
import { openClarifications, post, settlementViewFor } from './settlement-helpers.ts';

/**
 * Phase 14 (SEED, Order §§9–14): kanonischer Demo-Datensatz über echte
 * Fachpfade – Pflichtszenarien, Guards (nur demo, kein stilles Überschreiben),
 * synthetische Daten, relative Zeitlogik, Vorgangsnummern, Maschinenzustände.
 * Pflichttest-Nummern des Auftrags fehlen (Text endet bei §20) – Namen laufen
 * als „D-S<n>“. Läuft gegen eine eigene Test-DB (TEST_DATABASE_URL).
 */

const SEED_TIMEOUT_MS = 180_000;
const SYNTHETIC_MAIL = /@example\.(com|invalid)$/;

let ctx: TestContext;
let demo: DemoTestServices;
let adminId: string;
const now = demoTestNow();

beforeAll(async () => {
  ctx = await createDemoTestContext();
  demo = demoServicesFor(ctx);
  ({ adminId } = await freshDemoDatabase(ctx));
}, 120_000);

afterAll(async () => {
  await destroyTestContext(ctx);
});

async function resolveId(seedKey: string): Promise<string> {
  const ref = await demo.registry.resolve(seedKey);
  if (ref === null) throw new Error(`Seed-Schlüssel ${seedKey} fehlt`);
  return ref.entityId;
}

async function appointmentById(id: string) {
  const rows = await ctx.db.select().from(appointments).where(eq(appointments.id, id));
  return rows[0]!;
}

async function machineByCode(code: string) {
  const rows = await ctx.db.select().from(machines).where(eq(machines.machineCode, code));
  return rows[0]!;
}

/** Kunde eines Seed-Schlüssels (Registry ⇒ customers). */
async function customerByKey(context: TestContext, services: DemoTestServices, seedKey: string) {
  const ref = await services.registry.resolve(seedKey);
  if (ref === null) throw new Error(`Seed-Schlüssel ${seedKey} fehlt`);
  const rows = await context.db.select().from(customers).where(eq(customers.id, ref.entityId));
  return rows[0]!;
}

/** Alle fälligen Jobs des Test-Runners abarbeiten (ohne Obergrenze je Aufruf). */
async function drainJobs(context: TestContext): Promise<number> {
  let processed = 0;
  for (;;) {
    const outcome = await context.jobs.runOnce();
    if (outcome === 'idle') return processed;
    processed += 1;
    if (processed > 500) throw new Error('Jobs laufen nicht leer');
  }
}

describe('Phase 14 – Demo-Seed (kanonischer Datensatz)', () => {
  it(
    'D-S1. Seed auf leerer Demo-DB erzeugt alle Pflichtszenarien (Registry vollständig, Zähler > 0, Datenstand markiert)',
    async () => {
      const result = await demo.seed.seed({ actorId: adminId, now });
      expect(result.datasetVersion).toBe(DEMO_DATASET_VERSION);
      expect(result.actorId).toBe(adminId);
      expect(result.seeded.customers).toBeGreaterThanOrEqual(14);
      expect(result.seeded.processes).toBeGreaterThanOrEqual(16);
      expect(result.seeded.bookings).toBeGreaterThanOrEqual(11);
      expect(result.seeded.appointments).toBeGreaterThanOrEqual(22);
      expect(result.seeded.tours).toBe(2);
      expect(result.seeded.settlements).toBeGreaterThanOrEqual(5);
      expect(result.seeded.conversationMessages).toBeGreaterThanOrEqual(3);
      const keys = new Set((await demo.registry.list()).map((entry) => entry.seedKey));
      for (const required of REQUIRED_DEMO_SEED_KEYS) expect(keys.has(required)).toBe(true);
      // Phase 14 (accounting), W1.1: Gutschein-Situation als Seed-Fixture (kein Mock-Transfer).
      expect(keys.has(DEMO_SEED_KEYS.voucherSituation)).toBe(true);
      expect(result.seeded.seedEntities).toBe(keys.size);
      const state = await demo.dataset.state(now);
      expect(state.datasetVersion).toBe(DEMO_DATASET_VERSION);
      expect(state.seededAt?.toISOString()).toBe(now.toISOString());
      expect(state.seededBy).toBe(adminId);
      expect(state.outdated).toBe(false);
      expect(state.resetInProgress).toBe(false);
    },
    SEED_TIMEOUT_MS,
  );

  it('D-S2. Zweiter Seed auf bestehenden Demo-Daten ⇒ DEMO_DATA_EXISTS (kein stilles Überschreiben)', async () => {
    const before = await demo.seed.counts();
    await expect(demo.seed.seed({ actorId: adminId, now })).rejects.toMatchObject({
      name: 'DemoError',
      code: 'CONFLICT',
      demoCode: 'DEMO_DATA_EXISTS',
      message: DEMO_MESSAGES.DEMO_DATA_EXISTS,
    });
    expect(await demo.seed.counts()).toEqual(before);
  });

  it('D-S3. Seed außerhalb von APP_ENV=demo ⇒ DEMO_ONLY (auch mit leerem Bestand)', async () => {
    const devSeed = new DemoSeedService({
      db: ctx.db,
      config: { ...ctx.config, appEnv: 'development' },
      storage: ctx.storage,
      queue: ctx.queue,
      services: demo.services,
    });
    const error = await devSeed.seed({ actorId: adminId, now }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoError);
    expect((error as DemoError).demoCode).toBe('DEMO_ONLY');
    expect((error as DemoError).code).toBe('FORBIDDEN');
    // seedCanonical (Reset-Phase C) ist genauso geschützt.
    await expect(devSeed.seedCanonical({ actorId: adminId, now })).rejects.toMatchObject({
      demoCode: 'DEMO_ONLY',
    });
  });

  it('D-S4. Ohne Whitelist-Domain liegen alle E-Mail-Adressen des Datensatzes unter example.com / example.invalid (auch die Mail-Übungskunden)', async () => {
    const customerRows = await ctx.db.select({ email: customers.email }).from(customers);
    expect(customerRows.length).toBeGreaterThan(0);
    for (const row of customerRows) {
      expect(row.email).not.toBeNull();
      expect(row.email).toMatch(SYNTHETIC_MAIL);
    }
    const mails = await ctx.db
      .select({ recipient: mailDeliveries.recipientEmail })
      .from(mailDeliveries);
    expect(mails.length).toBeGreaterThan(0);
    for (const row of mails) expect(row.recipient).toMatch(SYNTHETIC_MAIL);
    const messages = await ctx.db
      .select({ sender: conversationMessages.senderSnapshot })
      .from(conversationMessages);
    for (const row of messages) {
      const email = (row.sender as { email?: string | null } | null)?.email ?? null;
      if (email !== null) expect(email).toMatch(SYNTHETIC_MAIL);
    }
    // Review-Fix F8 (Order §9): der Demo-Testkontext setzt KEINE MAIL_DEMO_WHITELIST ⇒ keine
    // Demo-Testdomain ⇒ auch die Kunden der Mail-Übungsszenarien behalten ihre Beispieldomain.
    expect(ctx.config.mail.demoWhitelist).toEqual([]);
    expect(demoWhitelistDomain(ctx.config)).toBeNull();
    expect(demoCustomerEmail(ctx.config, 'einkauf', 'example.invalid')).toBe(
      'einkauf@example.invalid',
    );
    expect(DEMO_MAIL_EXERCISE_CUSTOMERS.map((spec) => spec.key)).toEqual([
      DEMO_SEED_KEYS.customerPrivateBasic,
      DEMO_SEED_KEYS.customerOrgBasic,
      DEMO_CUSTOMERS.returnDamage.key,
      DEMO_CUSTOMERS.returnMissing.key,
      DEMO_CUSTOMERS.settlementReview.key,
    ]);
    for (const spec of DEMO_MAIL_EXERCISE_CUSTOMERS) {
      const customer = await customerByKey(ctx, demo, spec.key);
      expect(customer.email, spec.key).toBe(spec.email);
      expect(customer.email, spec.key).toMatch(SYNTHETIC_MAIL);
    }
  });

  it('D-S5. Telefonnummern bleiben leer (kein Fachflow des Seeds verlangt eine Nummer)', async () => {
    const phones = await ctx.db.select({ phone: customers.phone }).from(customers);
    for (const row of phones) expect(row.phone).toBeNull();
    const contacts = await ctx.db.select({ phone: inquiries.onsiteContactPhone }).from(inquiries);
    for (const row of contacts) expect(row.phone).toBeNull();
    const recipients = await ctx.db.select({ phone: handovers.recipientPhone }).from(handovers);
    for (const row of recipients) expect(row.phone).toBeNull();
    const returners = await ctx.db
      .select({ phone: rentalReturns.returnerPhone })
      .from(rentalReturns);
    for (const row of returners) expect(row.phone).toBeNull();
    expect(await ctx.db.select().from(bookingPickupRepresentatives)).toHaveLength(0);
  });

  it('D-S6. Zeitlogik relativ zu „jetzt“ (Berlin): Rückgabe gestern überfällig, Rückgabe heute fällig, Tour heute/morgen, Angebotsgültigkeit', async () => {
    const todayIso = berlinDateOf(now);
    const overdue = await appointmentById(await resolveId(DEMO_SEED_KEYS.appointmentReturnOverdue));
    expect(overdue.status).toBe('scheduled');
    expect(overdue.startAt?.toISOString()).toBe(
      berlinDateTimeToUtc(berlinDayShift(todayIso, -1), 11, 0).toISOString(),
    );
    const due = await appointmentById(await resolveId(DEMO_SEED_KEYS.appointmentReturnDueToday));
    expect(due.status).toBe('scheduled');
    expect(berlinDateOf(due.startAt!)).toBe(todayIso);
    expect(due.startAt!.getTime()).toBeGreaterThan(now.getTime());
    // Zeitfenster (Ende > Beginn) – nur am späten Abend ein exakter Zeitpunkt (23:59).
    if (due.endAt !== null) expect(due.endAt.getTime()).toBeGreaterThan(due.startAt!.getTime());
    const planned = await appointmentById(await resolveId(DEMO_SEED_KEYS.appointmentReturnPlanned));
    expect(planned.startAt?.toISOString()).toBe(
      berlinDateTimeToUtc(berlinDayShift(todayIso, 2), 11, 0).toISOString(),
    );
    const unplanned = await appointmentById(
      await resolveId(DEMO_SEED_KEYS.appointmentReturnUnplanned),
    );
    expect(unplanned.startAt).toBeNull();

    const tourRows = await ctx.db.select().from(tours).orderBy(asc(tours.tourDate));
    expect(tourRows.map((row) => row.tourDate)).toEqual([todayIso, berlinDayShift(todayIso, 1)]);
    const today = tourRows[0]!;
    expect(today.status).toBe('ready');
    expect(today.assignedUserId).toBe(adminId);
    const stops = await ctx.db.select().from(tourStops).where(eq(tourStops.tourId, today.id));
    expect(stops).toHaveLength(3);
    const tomorrow = tourRows[1]!;
    expect(tomorrow.status).toBe('draft');
    expect(tomorrow.planningStatus).toBe('planned');

    const sentProcessId = await resolveId(DEMO_SEED_KEYS.processOfferSent);
    const sentInquiry = (
      await ctx.db.select().from(inquiries).where(eq(inquiries.processId, sentProcessId))
    )[0]!;
    expect(sentInquiry.eventDate).toBe(berlinDayShift(todayIso, 10));
    const versions = await ctx.db
      .select()
      .from(offerVersions)
      .where(eq(offerVersions.status, 'sent'));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.sentAt?.toISOString()).toBe(now.toISOString());
    expect(versions[0]!.expiresAt?.toISOString()).toBe(
      offerExpiresAt(sentInquiry.eventDate!, now).toISOString(),
    );
  });

  it('D-S7. Vorgangsnummern kommen aus der Sequenz: MR-<Jahr>-0001 … fortlaufend in Seed-Reihenfolge', async () => {
    const rows = await ctx.db
      .select({ number: processes.processNumber })
      .from(processes)
      .orderBy(asc(processes.createdAt));
    const year = berlinDateOf(now).slice(0, 4);
    expect(rows.length).toBeGreaterThanOrEqual(16);
    rows.forEach((row, index) => {
      expect(row.number).toBe(`MR-${year}-${String(index + 1).padStart(4, '0')}`);
    });
    const first = await resolveId(DEMO_SEED_KEYS.processInquiryNew);
    const firstRow = (await ctx.db.select().from(processes).where(eq(processes.id, first)))[0]!;
    expect(firstRow.processNumber).toBe(`MR-${year}-0001`);
    expect(firstRow.assignedUserId).toBe(adminId);
    expect(firstRow.createdBy).toBe(adminId);
  });

  it('D-S8. Maschinenzustände: einsatzbereit, zugeordnet, reserviert, vermietet, Reinigung (frisch/überfällig), Reparatur + Sperre mit Grund', async () => {
    expect((await machineByCode(DEMO_MACHINES.handoverReady)).status).toBe('reserved');
    for (const code of [
      DEMO_MACHINES.rentalActive,
      DEMO_MACHINES.returnDue,
      DEMO_MACHINES.returnOverdue,
    ]) {
      const machine = await machineByCode(code);
      expect(machine.status).toBe('rented');
      expect(machine.locationKind).toBe('customer');
    }
    for (const code of [
      DEMO_MACHINES.returnDamage,
      DEMO_MACHINES.returnMissing,
      DEMO_MACHINES.settlementReview,
      DEMO_MACHINES.cleaningPending,
    ]) {
      const machine = await machineByCode(code);
      expect(machine.status).toBe('cleaning');
      expect(machine.cleaningSince).not.toBeNull();
    }
    const overdueCleaning = await machineByCode(DEMO_MACHINES.returnDamage);
    expect(now.getTime() - overdueCleaning.cleaningSince!.getTime()).toBeGreaterThan(
      24 * 3_600_000,
    );
    const fresh = await machineByCode(DEMO_MACHINES.cleaningPending);
    expect(now.getTime() - fresh.cleaningSince!.getTime()).toBeLessThan(3 * 3_600_000);
    const ready = await machineByCode(DEMO_MACHINES.readyAfterCleaning);
    expect(ready.status).toBe('ready');
    expect(ready.cleanedAt).not.toBeNull();
    expect(ready.cleanedBy).toBe(adminId);
    const assignedMachine = await machineByCode(DEMO_MACHINES.assigned);
    expect(assignedMachine.status).toBe('ready');
    const blocked = await machineByCode(DEMO_MACHINES.blocked);
    expect(blocked.status).toBe('repair');
    const blocks = await ctx.db
      .select()
      .from(machineBlocks)
      .where(eq(machineBlocks.machineId, blocked.id));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toBe(DEMO_MACHINE_BLOCK_REASON);
    expect(blocks[0]!.createdBy).toBe(adminId);
    const statuses = new Set(
      (await ctx.db.select({ status: machineAssignments.status }).from(machineAssignments)).map(
        (row) => row.status,
      ),
    );
    expect([...statuses].sort()).toEqual(['assigned', 'issued', 'prepared', 'returned']);
    const registered = await resolveId(DEMO_SEED_KEYS.machineBlocked);
    expect(registered).toBe(blocked.id);
  });

  it('D-S9. Versendetes Angebot: Mail liegt in der Outbox, in der Demo ohne Whitelist als blocked (DEMO_NOT_WHITELISTED) mit [DEMO]-Betreff', async () => {
    const processId = await resolveId(DEMO_SEED_KEYS.processOfferSent);
    const mails = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.processId, processId));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.kind).toBe('offer');
    expect(mails[0]!.status).toBe('blocked');
    expect(mails[0]!.blockedReason).toBe('DEMO_NOT_WHITELISTED');
    expect(mails[0]!.subject).toMatch(/^\[DEMO\]/);
    expect(mails[0]!.recipientEmail).toBe(DEMO_CUSTOMERS.offerSent.email);
    // Kein mail.send-Job für blockierte Zustellungen – nichts verlässt die Demo.
    const jobs = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM integration_jobs WHERE type = 'mail.send'`,
    );
    expect(jobs.rows[0].n).toBe(0);
  });

  it('D-S10. Abrechnungen: Schaden/Fehlteil/Prüfung mit offenen Klärungen, Reinigungsfall ohne Blocker bleibt „Bereit zur Buchhaltung“ (W1: kein Transfer-Job, kein Transfer in der Demo)', async () => {
    for (const key of [
      DEMO_SEED_KEYS.settlementReview,
      DEMO_SEED_KEYS.settlementDamage,
      DEMO_SEED_KEYS.settlementMissingPart,
    ]) {
      const row = (
        await ctx.db
          .select()
          .from(settlements)
          .where(eq(settlements.id, await resolveId(key)))
      )[0]!;
      expect(row.status).toBe('clarification_required');
      expect(row.lockedAt).toBeNull();
      expect(row.accountingTransferId).toBeNull();
    }
    const cleaningProcess = await resolveId(DEMO_SEED_KEYS.processCleaningPending);
    const cleaningSettlement = (
      await ctx.db.select().from(settlements).where(eq(settlements.processId, cleaningProcess))
    )[0]!;
    expect(cleaningSettlement.status).toBe('ready_for_accounting');
    expect(cleaningSettlement.accountingTransferId).toBeNull();
    expect(cleaningSettlement.accountingReference).toBeNull();
    // Phase 14 (accounting), Order W1/§29: Gateway in demo `disabled` ⇒ der Settlement-Hook
    // stellt keinen Auto-Transfer-Job ein; nichts wird (auch nicht per Mock) übertragen.
    const jobs = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM integration_jobs
       WHERE type IN ('settlement.accounting_transfer', 'cancellation.accounting_transfer', 'lexware.event.process')`,
    );
    expect(jobs.rows[0].n).toBe(0);
    const transfers = await ctx.pool.query(`SELECT count(*)::int AS n FROM accounting_transfers`);
    expect(transfers.rows[0].n).toBe(0);
    const completedProcess = await resolveId(DEMO_SEED_KEYS.processCompleted);
    const completed = (
      await ctx.db.select().from(processes).where(eq(processes.id, completedProcess))
    )[0]!;
    expect(completed.mainStatus).toBe('completed');
    // Abschluss über den normalen Fachpfad (ProcessService.complete) – die Abrechnung des
    // abgeschlossenen Vorgangs bleibt ohne Übertragung „Bereit zur Buchhaltung“.
    const completedSettlement = (
      await ctx.db.select().from(settlements).where(eq(settlements.processId, completedProcess))
    )[0]!;
    expect(completedSettlement.status).toBe('ready_for_accounting');
    expect(completedSettlement.accountingTransferId).toBeNull();
    const repeatCustomer = await resolveId(DEMO_SEED_KEYS.customerPrivateRepeat);
    const repeatProcesses = await ctx.db
      .select({ id: processes.id })
      .from(processes)
      .where(eq(processes.customerId, repeatCustomer));
    expect(repeatProcesses).toHaveLength(2);
  });

  it('D-S11. Kommunikation: eingehende Kunden-Mail, Staff-Antwort über die Outbox (blocked), unbeantwortete Anfrage-Mail', async () => {
    const inbound = (
      await ctx.db
        .select()
        .from(conversationMessages)
        .where(
          eq(conversationMessages.id, await resolveId(DEMO_SEED_KEYS.conversationEmailInbound)),
        )
    )[0]!;
    expect(inbound.direction).toBe('inbound');
    expect(inbound.channel).toBe('email');
    expect(inbound.processId).toBe(await resolveId(DEMO_SEED_KEYS.processOfferDraft));
    const reply = (
      await ctx.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, await resolveId(DEMO_SEED_KEYS.conversationEmailReply)))
    )[0]!;
    expect(reply.direction).toBe('outbound');
    expect(reply.deliveryState).toBe('blocked');
    expect(reply.createdByStaffId).toBe(adminId);
    expect(reply.mailDeliveryId).not.toBeNull();
    const unanswered = (
      await ctx.db
        .select()
        .from(conversationMessages)
        .where(
          eq(conversationMessages.id, await resolveId(DEMO_SEED_KEYS.conversationEmailUnanswered)),
        )
    )[0]!;
    expect(unanswered.processId).toBe(await resolveId(DEMO_SEED_KEYS.processInquiryNew));
  });

  it('D-S12. Lager: Erstinventur, Wareneingang, Ausgaben/Rückläufer aus Übergabe/Rückgabe, Mindestbestand-Warnung', async () => {
    const kinds = new Set(
      (await ctx.db.select({ kind: inventoryMovements.kind }).from(inventoryMovements)).map(
        (row) => row.kind,
      ),
    );
    expect(kinds.has('initial')).toBe(true);
    expect(kinds.has('incoming')).toBe(true);
    expect(kinds.has('issue')).toBe(true);
    expect(kinds.has('return')).toBe(true);
    const items = await demo.services.inventory.listItems();
    const low = items.filter((item) => item.lowStock);
    expect(low.map((item) => item.productSlug)).toEqual(['mischkanister-6l']);
    for (const item of items) expect(item.currentStock).not.toBeNull();
    expect(await resolveId(DEMO_SEED_KEYS.inventoryItemLowStock)).toBe(low[0]!.itemId);
  });

  it('D-S13. Fachaktor: nur bestehende aktive Konten; ohne Systemadmin bricht der Seed mit klarer Meldung ab (nie anlegen)', async () => {
    await expect(
      resolveDemoSeedActor(ctx.db, demo.services.auth, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ demoCode: 'DEMO_ACTOR_INVALID' });
    expect(await findFirstActiveSystemAdmin(ctx.db)).toBe(adminId);
    await truncateAuthTables(ctx.pool);
    expect(await findFirstActiveSystemAdmin(ctx.db)).toBeNull();
    await expect(demo.seed.seed({ actorId: null, now })).rejects.toMatchObject({
      demoCode: 'DEMO_ADMIN_MISSING',
    });
    const staff = await ctx.pool.query('SELECT count(*)::int AS n FROM staff_users');
    expect(staff.rows[0].n).toBe(0);
  });
});

/**
 * Review-Fix F8 (Order §9 „konfigurierte Demo-Testadresse“, §25, §78, §79):
 * Demo-Konfiguration MIT `@domain`-Eintrag in MAIL_DEMO_WHITELIST – die Kunden
 * der Mail-Übungsszenarien erhalten Adressen unter der ersten Whitelist-Domain,
 * alle anderen bleiben auf example.com / example.invalid. Damit ist die
 * Abrechnungs-Übung auch MIT berechneter Belastung bis „Bereit zur Buchhaltung“
 * durchführbar (Kundeninformation wird tatsächlich `sent`), ohne Übertragung.
 * Eigener Testkontext (gleiche DB, frisch geleert) – läuft nach den Tests oben.
 */
describe('Phase 14 – Demo-Seed mit konfigurierter Demo-Testadresse (Order §9/§25)', () => {
  const WHITELIST_DOMAIN = 'demo.test';
  const WHITELIST_ADDRESS = `senke@${WHITELIST_DOMAIN}`;
  const REACHABLE_MAIL = new RegExp(`@${WHITELIST_DOMAIN.replace('.', '\\.')}$`);
  let ctxWl: TestContext;
  let demoWl: DemoTestServices;
  let adminWlId: string;
  let cookieWl = '';

  beforeAll(async () => {
    // Vollmatch-Adresse zuerst (wird nie vergeben), dann zwei Domains ⇒ die ERSTE Domain gilt.
    // MAIL_PUBLIC_WEB_BASE_URL wie im Demo-Deployment (Mails mit Links, z. B. Angebote, brauchen sie).
    ctxWl = await createTestContext({
      appEnv: 'demo',
      env: {
        MAIL_DEMO_WHITELIST: `${WHITELIST_ADDRESS}, @${WHITELIST_DOMAIN}, @zweite.test`,
        MAIL_PUBLIC_WEB_BASE_URL: 'https://web.demo.test',
      },
    });
    demoWl = demoServicesFor(ctxWl);
    ({ adminId: adminWlId } = await freshDemoDatabase(ctxWl));
    await demoWl.seed.seed({ actorId: adminWlId, now });
    const session = await login(ctxWl.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    if (session.statusCode !== 200) throw new Error(`Demo-Login: ${session.statusCode}`);
    cookieWl = session.cookie;
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    await destroyTestContext(ctxWl);
  });

  it('D-S4b. Mit Whitelist-Domain tragen nur die Mail-Übungskunden `<lokalteil>@<erste Domain>`; alle anderen bleiben example.*; Vollmatch-Adresse nie vergeben; Mails an sie werden tatsächlich zugestellt', async () => {
    expect(ctxWl.config.mail.demoWhitelist).toEqual([
      WHITELIST_ADDRESS,
      `@${WHITELIST_DOMAIN}`,
      '@zweite.test',
    ]);
    expect(demoWhitelistDomain(ctxWl.config)).toBe(WHITELIST_DOMAIN);
    expect(demoCustomerEmail(ctxWl.config, 'einkauf', 'example.invalid')).toBe(
      `einkauf@${WHITELIST_DOMAIN}`,
    );

    // Betroffene Kunden: Lokalteil wie bisher, Domain = erste Whitelist-Domain.
    const exerciseIds = new Set<string>();
    for (const spec of DEMO_MAIL_EXERCISE_CUSTOMERS) {
      const customer = await customerByKey(ctxWl, demoWl, spec.key);
      exerciseIds.add(customer.id);
      const localPart = spec.email.slice(0, spec.email.indexOf('@'));
      expect(customer.email, spec.key).toBe(`${localPart}@${WHITELIST_DOMAIN}`);
    }
    const beispielWerke = await customerByKey(ctxWl, demoWl, DEMO_CUSTOMERS.settlementReview.key);
    expect(beispielWerke.email).toBe(`einkauf@${WHITELIST_DOMAIN}`);
    expect(beispielWerke.organizationName).toBe(DEMO_CUSTOMERS.settlementReview.organizationName);

    // Alle übrigen Kunden unverändert synthetisch; keine Adresse doppelt; Vollmatch nie vergeben.
    const customerRows = await ctxWl.db
      .select({ id: customers.id, email: customers.email })
      .from(customers);
    expect(customerRows.length).toBeGreaterThanOrEqual(14);
    const emails = customerRows.map((row) => row.email);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails).not.toContain(WHITELIST_ADDRESS);
    for (const row of customerRows) {
      expect(row.email).not.toBeNull();
      if (exerciseIds.has(row.id)) expect(row.email).toMatch(REACHABLE_MAIL);
      else expect(row.email, row.email ?? '').toMatch(SYNTHETIC_MAIL);
      expect(row.email).not.toMatch(/@zweite\.test$/);
    }
    // `process.offer.sent` bleibt bewusst blockiert (sichtbares Whitelist-Beispiel).
    const offerSent = await customerByKey(ctxWl, demoWl, DEMO_CUSTOMERS.offerSent.key);
    expect(offerSent.email).toBe(DEMO_CUSTOMERS.offerSent.email);

    // Outbox: Mails an die Demo-Testdomain sind eingereiht (pending), alle anderen blocked.
    const deliveries = await ctxWl.db.select().from(mailDeliveries);
    expect(deliveries.length).toBeGreaterThan(0);
    const pending = deliveries.filter((row) => row.status === 'pending');
    const blocked = deliveries.filter((row) => row.status === 'blocked');
    expect(pending.length).toBeGreaterThan(0);
    expect(blocked.length).toBeGreaterThan(0);
    expect(pending.length + blocked.length).toBe(deliveries.length);
    for (const row of pending) expect(row.recipientEmail).toMatch(REACHABLE_MAIL);
    for (const row of blocked) {
      expect(row.recipientEmail).toMatch(SYNTHETIC_MAIL);
      expect(row.blockedReason).toBe('DEMO_NOT_WHITELISTED');
    }
    for (const row of deliveries) expect(row.subject).toMatch(/^\[DEMO\]/);
    const sentOffer = await resolveWl(DEMO_SEED_KEYS.processOfferSent);
    expect(deliveries.find((row) => row.processId === sentOffer)?.status).toBe('blocked');

    // Konversation: Absender = Kundenadresse; die Seed-Antwort ist eingereiht (queued), nicht blocked.
    const inbound = await messageWl(DEMO_SEED_KEYS.conversationEmailInbound);
    expect((inbound.senderSnapshot as { email?: string }).email).toBe(`verein@${WHITELIST_DOMAIN}`);
    const unanswered = await messageWl(DEMO_SEED_KEYS.conversationEmailUnanswered);
    expect((unanswered.senderSnapshot as { email?: string }).email).toBe(
      `lena.beispiel@${WHITELIST_DOMAIN}`,
    );
    const reply = await messageWl(DEMO_SEED_KEYS.conversationEmailReply);
    expect(reply.deliveryState).toBe('queued');

    // Test-Runner (wie der Demo-Worker): alle eingereihten Mails gehen über den Fake an die Senke –
    // ausschließlich an die Whitelist-Domain, immer mit [DEMO]-Betreff (Order §25).
    ctxWl.mailGateway.reset();
    expect(await drainJobs(ctxWl)).toBeGreaterThanOrEqual(pending.length);
    const after = await ctxWl.db.select().from(mailDeliveries);
    expect(after.filter((row) => row.status === 'sent')).toHaveLength(pending.length);
    expect(after.filter((row) => row.status === 'blocked')).toHaveLength(blocked.length);
    expect(ctxWl.mailGateway.sent).toHaveLength(pending.length);
    for (const message of ctxWl.mailGateway.sent) {
      expect(message.to.email).toMatch(REACHABLE_MAIL);
      expect(message.subject).toMatch(/^\[DEMO\]/);
    }
    expect((await messageWl(DEMO_SEED_KEYS.conversationEmailReply)).deliveryState).toBe('sent');
  });

  it('D-S14. Abrechnung mit Belastung ist in der Demo bis vor die Buchhaltung durchführbar (Belastung ⇒ Kundeninformation gesendet ⇒ Wartefenster ⇒ Bereit zur Buchhaltung; keine Übertragung; Übung settlement_review bestanden)', async () => {
    const processId = await resolveWl(DEMO_SEED_KEYS.processSettlementReview);
    const settlementId = await resolveWl(DEMO_SEED_KEYS.settlementReview);
    // Übung bewusst starten (Order §39) – der Fachaktor ist hier zugleich Trainee.
    const started = await ctxWl.app.inject({
      method: 'POST',
      url: '/staff/training/attempts',
      headers: { cookie: cookieWl },
      payload: { definitionKey: 'settlement_review' },
    });
    expect(started.statusCode).toBe(201);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;

    let view = await settlementViewFor(ctxWl.app, cookieWl, processId);
    expect(view.settlement.id).toBe(settlementId);
    expect(view.settlement.status).toBe('clarification_required');

    // Belastungen festlegen: Schaden 50,00 €, Fehlteil 15,00 € ⇒ Kundeninformation erforderlich.
    const damage = openClarifications(view, 'damage_cost')[0]!;
    let result = await post(
      ctxWl.app,
      cookieWl,
      `/staff/settlements/${settlementId}/clarifications/${damage.id}/resolve`,
      { decision: 'charge', amountCents: 5000, version: view.settlement.version },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    view = await settlementViewFor(ctxWl.app, cookieWl, processId);
    const missing = openClarifications(view, 'missing_item_cost')[0]!;
    result = await post(
      ctxWl.app,
      cookieWl,
      `/staff/settlements/${settlementId}/clarifications/${missing.id}/resolve`,
      { decision: 'charge', amountCents: 1500, version: view.settlement.version },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    view = await settlementViewFor(ctxWl.app, cookieWl, processId);
    // Kostenentscheide erledigt; offen bleibt nur die Klärung „Kundeninformation“ (§25).
    expect(openClarifications(view).map((c) => c.type)).toEqual(['customer_notice']);
    expect(view.settlement.status).toBe('customer_notice_required');
    expect(view.settlement.noticeRequired).toBe(true);
    expect(view.notice).toMatchObject({
      status: 'prepared',
      recipientEmail: `einkauf@${WHITELIST_DOMAIN}`,
      totalCents: 6500,
    });

    // Freigeben und senden ⇒ Outbox pending (Whitelist-Domain), Frist beginnt erst mit Mailerfolg.
    ctxWl.mailGateway.reset();
    result = await post(
      ctxWl.app,
      cookieWl,
      `/staff/settlements/${settlementId}/notice/approve-and-send`,
      { version: view.settlement.version },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    view = await settlementViewFor(ctxWl.app, cookieWl, processId);
    expect(view.settlement.status).toBe('customer_notice_required');
    expect(view.settlement.noticeSentAt).toBeNull();
    const queued = (
      await ctxWl.db
        .select()
        .from(mailDeliveries)
        .where(eq(mailDeliveries.kind, 'settlement_damage_missing_notice'))
    ).filter((row) => row.processId === processId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      status: 'pending',
      recipientEmail: `einkauf@${WHITELIST_DOMAIN}`,
      blockedReason: null,
    });
    expect(queued[0]!.subject).toMatch(/^\[DEMO\]/);

    // Mail-Job über den Test-Runner (wie der Demo-Worker) ⇒ sent ⇒ Kundenrückmeldung abwarten.
    await drainJobs(ctxWl);
    const noticeMail = ctxWl.mailGateway.sent.find(
      (m) => m.to.email === `einkauf@${WHITELIST_DOMAIN}`,
    );
    expect(noticeMail?.subject).toMatch(/^\[DEMO\] /);
    view = await settlementViewFor(ctxWl.app, cookieWl, processId);
    expect(view.settlement.status).toBe('customer_waiting');
    expect(view.settlement.noticeSentAt).not.toBeNull();
    expect(view.settlement.waitUntil).not.toBeNull();
    expect(openClarifications(view)).toHaveLength(0);
    // W1/§29: in der Demo plant der Versand KEINEN Auto-Transfer.
    expect(view.settlement.autoTransferPlannedAt).toBeNull();

    // Wartefenster beenden („Jetzt freigeben“) ⇒ Bereit zur Buchhaltung – ohne Übertragung.
    result = await post(ctxWl.app, cookieWl, `/staff/settlements/${settlementId}/end-wait`, {
      version: view.settlement.version,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    view = await settlementViewFor(ctxWl.app, cookieWl, processId);
    expect(view.settlement.status).toBe('ready_for_accounting');
    expect(openClarifications(view)).toHaveLength(0);
    expect(view.settlement.accountingBlocker).toBe('demo_unavailable');
    expect(view.settlement.accountingReference).toBeNull();
    expect(view.transfer).toBeNull();
    const settlementRow = (
      await ctxWl.db.select().from(settlements).where(eq(settlements.id, settlementId))
    )[0]!;
    expect(settlementRow.status).toBe('ready_for_accounting');
    expect(settlementRow.accountingTransferId).toBeNull();
    await drainJobs(ctxWl);
    const transferJobs = await ctxWl.pool.query(
      `SELECT count(*)::int AS n FROM integration_jobs
       WHERE type IN ('settlement.accounting_transfer', 'cancellation.accounting_transfer', 'lexware.event.process')`,
    );
    expect(transferJobs.rows[0].n).toBe(0);
    const transfers = await ctxWl.pool.query(`SELECT count(*)::int AS n FROM accounting_transfers`);
    expect(transfers.rows[0].n).toBe(0);
    const processRow = (
      await ctxWl.db.select().from(processes).where(eq(processes.id, processId))
    )[0]!;
    expect(processRow.mainStatus).not.toBe('completed');

    // Übung `settlement_review`: Übergang nach ready_for_accounting ⇒ Ereignis ⇒ bestanden (Order §79).
    const detail = await ctxWl.app.inject({
      method: 'GET',
      url: `/staff/training/attempts/${attemptId}`,
      headers: { cookie: cookieWl },
    });
    expect(detail.statusCode).toBe(200);
    const attemptDetail = detail.json() as {
      attempt: { status: string };
      events: { eventKey: string; result: string }[];
    };
    expect(attemptDetail.attempt.status).toBe('passed');
    expect(attemptDetail.events).toContainEqual(
      expect.objectContaining({ eventKey: 'settlement.reviewed', result: 'accepted' }),
    );
  });

  async function resolveWl(seedKey: string): Promise<string> {
    const ref = await demoWl.registry.resolve(seedKey);
    if (ref === null) throw new Error(`Seed-Schlüssel ${seedKey} fehlt`);
    return ref.entityId;
  }

  async function messageWl(seedKey: string) {
    const rows = await ctxWl.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, await resolveWl(seedKey)));
    return rows[0]!;
  }
});
