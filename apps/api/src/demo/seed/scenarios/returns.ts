import { settlements } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { DemoScenario, DemoSeedContext } from '../context.ts';
import {
  DEMO_ADDRESSES,
  DEMO_CUSTOMERS,
  DEMO_MACHINES,
  DEMO_SEED_KEYS,
  withDemoTestAddress,
} from '../data.ts';
import {
  acceptDemoOffer,
  confirmDemoBooking,
  createDemoCustomer,
  createDemoDraft,
  createDemoProcess,
  finalizeDemoReturn,
  issueDemoBooking,
  machineIdByCode,
  scheduleDemoAppointments,
  sendDemoOffer,
  type InquirySpec,
} from './builders.ts';

async function settlementIdFor(ctx: DemoSeedContext, processId: string): Promise<string> {
  const rows = await ctx.db
    .select({ id: settlements.id })
    .from(settlements)
    .where(eq(settlements.processId, processId));
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Demo-Seed: Abrechnung nach der Rückgabe-Finalisierung fehlt');
  }
  return row.id;
}

/** Selbstabholung: Angebot → Annahme → Termine → AB → Ausgabe (ohne Rückgabe). */
async function issuedPickupBooking(
  ctx: DemoSeedContext,
  input: {
    customer: Parameters<typeof createDemoCustomer>[1];
    inquiry: InquirySpec;
    acceptedAt: Date;
    outboundAt: Date;
    inboundAt: Date;
    machineCode: string;
    issuedAt: Date;
  },
): Promise<{ processId: string; bookingId: string; customerId: string }> {
  const customerId = await createDemoCustomer(ctx, input.customer);
  const { processId } = await createDemoProcess(ctx, {
    customerId,
    source: 'website',
    assignToActor: true,
    inquiry: input.inquiry,
  });
  const { versionId } = await createDemoDraft(ctx, processId);
  const { token } = await sendDemoOffer(ctx, versionId, input.acceptedAt);
  const { bookingId } = await acceptDemoOffer(ctx, token, input.acceptedAt);
  await scheduleDemoAppointments(
    ctx,
    bookingId,
    { outbound: { startAt: input.outboundAt }, inbound: { startAt: input.inboundAt } },
    input.acceptedAt,
  );
  await confirmDemoBooking(ctx, bookingId, 'send', input.acceptedAt);
  await issueDemoBooking(ctx, bookingId, [input.machineCode], input.issuedAt);
  return { processId, bookingId, customerId };
}

/**
 * Rückgabe mit Schaden: Klärung „Schadenskosten“ offen, Maschine seit > 24 h in
 * Reinigung (Warnung). Kunde mit Demo-Testadresse (Order §9): eine berechnete
 * Belastung erfordert die Kundeninformation per Mail.
 */
export const returnDamageScenario: DemoScenario = {
  name: 'process.return.damage',
  async run(ctx) {
    const { processId, bookingId } = await issuedPickupBooking(ctx, {
      customer: withDemoTestAddress(ctx.config, DEMO_CUSTOMERS.returnDamage),
      inquiry: {
        eventInDays: -3,
        guestCount: 45,
        occasion: 'birthday',
        machineSlug: 'slush-1x10',
        fulfillment: 'pickup',
        selections: [{ slug: 'sirup-kirsche', role: 'free', quantity: 1 }],
      },
      acceptedAt: ctx.clock.at(-8, 10, 0),
      outboundAt: ctx.clock.at(-4, 18, 0),
      inboundAt: ctx.clock.at(-2, 11, 0),
      machineCode: DEMO_MACHINES.returnDamage,
      issuedAt: ctx.clock.at(-4, 18, 5),
    });
    await finalizeDemoReturn(
      ctx,
      bookingId,
      {
        damages: [
          {
            severity: 'medium',
            description: 'Kratzer am Gehäuse links, Deckelscharnier locker (DEMO)',
          },
        ],
      },
      ctx.clock.at(-2, 11, 30),
    );
    await ctx.register(DEMO_SEED_KEYS.processReturnDamage, 'process', processId);
    await ctx.register(
      DEMO_SEED_KEYS.settlementDamage,
      'settlement',
      await settlementIdFor(ctx, processId),
    );
    await ctx.register(
      DEMO_SEED_KEYS.machineCleaningOverdue,
      'machine',
      await machineIdByCode(ctx.db, DEMO_MACHINES.returnDamage),
    );
  },
};

/**
 * Rückgabe mit Fehlteil (Deckel): Klärung „Fehlteilkosten“ offen, Fehlteil-
 * Nachverfolgung aktiv. Kunde mit Demo-Testadresse (Order §9).
 */
export const returnMissingPartScenario: DemoScenario = {
  name: 'process.return.missing_part',
  async run(ctx) {
    const { processId, bookingId } = await issuedPickupBooking(ctx, {
      customer: withDemoTestAddress(ctx.config, DEMO_CUSTOMERS.returnMissing),
      inquiry: {
        eventInDays: -2,
        guestCount: 30,
        occasion: 'party',
        machineSlug: 'slush-1x10',
        fulfillment: 'pickup',
        selections: [{ slug: 'sirup-wassermelone', role: 'free', quantity: 1 }],
      },
      acceptedAt: ctx.clock.at(-7, 15, 0),
      outboundAt: ctx.clock.at(-3, 18, 0),
      inboundAt: ctx.clock.at(-1, 11, 0),
      machineCode: DEMO_MACHINES.returnMissing,
      issuedAt: ctx.clock.at(-3, 18, 5),
    });
    await finalizeDemoReturn(
      ctx,
      bookingId,
      {
        missing: [
          {
            accessoryType: 'lid',
            quantity: 1,
            description: 'Deckel fehlt – Kunde sucht zu Hause nach (DEMO)',
          },
        ],
      },
      ctx.clock.at(-1, 11, 20),
    );
    await ctx.register(DEMO_SEED_KEYS.processReturnMissingPart, 'process', processId);
    await ctx.register(
      DEMO_SEED_KEYS.settlementMissingPart,
      'settlement',
      await settlementIdFor(ctx, processId),
    );
  },
};

/**
 * Abrechnung in Prüfung (Organisation, Lieferung): Schaden + Fehlteil +
 * Reinigungsmangel + teilweise ungeöffnet zurückgegebene Kommissionsware –
 * mehrere offene Klärungen (Status „Klärung erforderlich“). Der Kunde trägt
 * die Demo-Testadresse (Order §9): Berechnet der Trainee Kosten, kann die
 * Kundeninformation tatsächlich versendet und die Abrechnung bis „Bereit zur
 * Buchhaltung“ gebracht werden (Übung `settlement_review`, Order §79).
 */
export const settlementReviewScenario: DemoScenario = {
  name: 'process.settlement.review',
  async run(ctx) {
    const acceptedAt = ctx.clock.at(-12, 10, 0);
    const customerId = await createDemoCustomer(
      ctx,
      withDemoTestAddress(ctx.config, DEMO_CUSTOMERS.settlementReview),
    );
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: -4,
        guestCount: 150,
        occasion: 'company_event',
        machineSlug: 'slush-2x10',
        fulfillment: 'delivery',
        delivery: DEMO_ADDRESSES.demoWerke,
        deliveryWindow: { from: ctx.clock.at(-6, 9, 0), to: ctx.clock.at(-6, 11, 0) },
        collectionWindow: { from: ctx.clock.at(-3, 10, 0), to: ctx.clock.at(-3, 12, 0) },
        selections: [
          { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
          { slug: 'sirup-wassermelone', role: 'free', quantity: 1 },
          { slug: 'sirup-blaue-himbeere', role: 'extra', quantity: 3 },
          { slug: 'mischkanister-6l', role: 'extra', quantity: 2 },
        ],
        onsiteContactName: 'Dr. Petra Prüfung',
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId, { deliveryPriceCents: 6000 });
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    await confirmDemoBooking(ctx, bookingId, 'send', acceptedAt);
    await issueDemoBooking(
      ctx,
      bookingId,
      [DEMO_MACHINES.settlementReview],
      ctx.clock.at(-6, 10, 0),
    );
    await finalizeDemoReturn(
      ctx,
      bookingId,
      {
        damages: [{ severity: 'light', description: 'Kleine Delle an der Tropfschale (DEMO)' }],
        missing: [{ accessoryType: 'drip_tray', quantity: 1 }],
        cleanupMachines: [0],
        returnedUnopened: [{ match: 'Himbeere', quantity: 1 }],
      },
      ctx.clock.at(-3, 12, 0),
    );
    await ctx.register(DEMO_SEED_KEYS.processSettlementReview, 'process', processId);
    await ctx.register(
      DEMO_SEED_KEYS.settlementReview,
      'settlement',
      await settlementIdFor(ctx, processId),
    );
  },
};

/**
 * Reinigung: beanstandungsfreie Rückgabe vor 90 Minuten, Maschine in Reinigung
 * (noch keine 24-h-Warnung). Die Abrechnung ist ohne Blocker und bleibt in der
 * Demo STABIL bei `ready_for_accounting` („Bereit zur Buchhaltung“): seit W1
 * (Phase 14, Order §29/§30) ist das Buchhaltungs-Gateway in demo `disabled`,
 * der Settlement-Hook stellt keinen Auto-Transfer-Job ein, der Demo-Worker
 * überträgt nichts und schließt den Vorgang nicht ab (Review F2 damit
 * gegenstandslos). Trainings-/E2E-Szenarien dürfen hier einen OFFENEN Vorgang
 * mit blockerfreier Abrechnung voraussetzen; die Oberfläche zeigt
 * „Buchhaltungsübertragung ist in der Demo nicht verfügbar.“ (kein Fehler).
 */
export const cleaningPendingScenario: DemoScenario = {
  name: 'process.cleaning.pending',
  async run(ctx) {
    const { processId, bookingId } = await issuedPickupBooking(ctx, {
      customer: DEMO_CUSTOMERS.cleaningPending,
      inquiry: {
        eventInDays: -1,
        guestCount: 20,
        occasion: 'birthday',
        machineSlug: 'slush-1x8',
        fulfillment: 'pickup',
        selections: [{ slug: 'sirup-kirsche', role: 'free', quantity: 1 }],
      },
      acceptedAt: ctx.clock.at(-5, 12, 0),
      outboundAt: ctx.clock.at(-2, 18, 0),
      inboundAt: ctx.clock.hoursAgo(2),
      machineCode: DEMO_MACHINES.cleaningPending,
      issuedAt: ctx.clock.at(-2, 18, 5),
    });
    await finalizeDemoReturn(ctx, bookingId, {}, ctx.clock.minutesAgo(90));
    await ctx.register(DEMO_SEED_KEYS.processCleaningPending, 'process', processId);
    await ctx.register(
      DEMO_SEED_KEYS.machineCleaning,
      'machine',
      await machineIdByCode(ctx.db, DEMO_MACHINES.cleaningPending),
    );
  },
};

/**
 * Abgeschlossener Vorgang (erster Vorgang des Wiedermieters): Rückgabe vor
 * zwölf Tagen, Maschine „gereinigt & einsatzbereit“, Abschluss über den
 * normalen Fachpfad `ProcessService.complete` (prüft keine Buchhaltung) – OHNE
 * Buchhaltungs-Transfer, denn in der Demo gibt es keine externe Übertragung
 * (W1, Order §29): die Abrechnung bleibt `ready_for_accounting`, es entsteht
 * kein `accounting_transfer`, keine Providerreferenz, keine Rechnungsnummer.
 * Kein Fixture nötig. `completed_at` ist nicht injizierbar und trägt den
 * echten Zeitpunkt des Seeds. Der Gutschein des Wiedermieters zu diesem
 * Vorgang entsteht anschließend in der Fixture-Schicht (`voucher.situation`,
 * fixtures/voucher-fixture.ts, Order W1.1).
 */
export const completedScenario: DemoScenario = {
  name: 'process.completed',
  async run(ctx) {
    const customerId = await ctx.resolve(DEMO_SEED_KEYS.customerPrivateRepeat);
    const acceptedAt = ctx.clock.at(-20, 10, 0);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: -13,
        guestCount: 25,
        occasion: 'birthday',
        machineSlug: 'slush-1x8',
        fulfillment: 'pickup',
        selections: [{ slug: 'sirup-waldmeister', role: 'free', quantity: 1 }],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId);
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    await scheduleDemoAppointments(
      ctx,
      bookingId,
      {
        outbound: { startAt: ctx.clock.at(-14, 18, 0) },
        inbound: { startAt: ctx.clock.at(-12, 11, 0) },
      },
      acceptedAt,
    );
    await confirmDemoBooking(ctx, bookingId, 'send', acceptedAt);
    await issueDemoBooking(
      ctx,
      bookingId,
      [DEMO_MACHINES.readyAfterCleaning],
      ctx.clock.at(-14, 18, 5),
    );
    await finalizeDemoReturn(ctx, bookingId, {}, ctx.clock.at(-12, 11, 10));
    const machineId = await machineIdByCode(ctx.db, DEMO_MACHINES.readyAfterCleaning);
    await ctx.services.returns.completeCleaning(ctx.actorId, machineId, ctx.clock.at(-12, 14, 0));
    await ctx.services.processes.complete(processId, ctx.visibility);
    await ctx.register(DEMO_SEED_KEYS.processCompleted, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.machineReadyBasic, 'machine', machineId);
  },
};

/** Wiedermieter: zweiter Vorgang desselben Kunden (neue Anfrage mit Angebotsentwurf). */
export const repeatSecondScenario: DemoScenario = {
  name: 'process.repeat.second',
  async run(ctx) {
    const customerId = await ctx.resolve(DEMO_SEED_KEYS.customerPrivateRepeat);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'staff_manual',
      assignToActor: true,
      inquiry: {
        eventInDays: 30,
        guestCount: 200,
        occasion: 'festival',
        machineSlug: 'slush-2x10',
        fulfillment: 'pickup',
        selections: [
          { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
          { slug: 'sirup-waldmeister', role: 'free', quantity: 1 },
        ],
      },
    });
    await createDemoDraft(ctx, processId);
    await ctx.register(DEMO_SEED_KEYS.processRepeatSecond, 'process', processId);
  },
};
