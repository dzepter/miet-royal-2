import type { DemoScenario } from '../context.ts';
import { DEMO_ADDRESSES, DEMO_CUSTOMERS, DEMO_MACHINES, DEMO_SEED_KEYS } from '../data.ts';
import {
  acceptDemoOffer,
  appointmentsOf,
  confirmDemoBooking,
  createDemoCustomer,
  createDemoDraft,
  createDemoProcess,
  issueDemoBooking,
  machineIdByCode,
  prepareDemoMachines,
  scheduleDemoAppointments,
  sendDemoOffer,
} from './builders.ts';

/**
 * Ausgabe vorbereitet: Lieferung morgen, Maschine zugewiesen und vorbereitet
 * (Status „reserviert“, Slot „prepared“, Übergabe im Entwurf) – die Übergabe
 * selbst (Prüfung, Foto, Unterschriften, Abschluss) bleibt als Übung offen.
 */
export const handoverReadyScenario: DemoScenario = {
  name: 'process.handover.ready',
  async run(ctx) {
    const acceptedAt = ctx.clock.at(-4, 11, 0);
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.handoverReady);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 2,
        guestCount: 30,
        occasion: 'birthday',
        machineSlug: 'slush-1x10',
        fulfillment: 'delivery',
        delivery: DEMO_ADDRESSES.lieferweg34,
        deliveryWindow: { from: ctx.clock.at(1, 10, 0), to: ctx.clock.at(1, 11, 0) },
        collectionWindow: { from: ctx.clock.at(3, 11, 0), to: ctx.clock.at(3, 12, 0) },
        selections: [{ slug: 'sirup-kirsche', role: 'free', quantity: 1 }],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId, { deliveryPriceCents: 2000 });
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    await confirmDemoBooking(ctx, bookingId, 'send', acceptedAt);
    await prepareDemoMachines(ctx, bookingId, [DEMO_MACHINES.handoverReady], ctx.now);
    const { outbound } = await appointmentsOf(ctx.db, bookingId);
    await ctx.register(DEMO_SEED_KEYS.processHandoverReady, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.appointmentDeliveryTomorrow, 'appointment', outbound.id);
    await ctx.register(
      DEMO_SEED_KEYS.machineReserved,
      'machine',
      await machineIdByCode(ctx.db, DEMO_MACHINES.handoverReady),
    );
  },
};

/** Laufende Vermietung: Übergabe vor zwei Tagen finalisiert, Rückgabe in zwei Tagen geplant. */
export const rentalActiveScenario: DemoScenario = {
  name: 'process.rental.active',
  async run(ctx) {
    const acceptedAt = ctx.clock.at(-7, 10, 0);
    const issuedAt = ctx.clock.at(-2, 18, 5);
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.rentalActive);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 0,
        guestCount: 40,
        occasion: 'party',
        machineSlug: 'slush-1x10',
        fulfillment: 'pickup',
        selections: [
          { slug: 'sirup-wassermelone', role: 'free', quantity: 1 },
          { slug: 'sirup-kirsche', role: 'extra', quantity: 1 },
        ],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId);
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    const { inboundId } = await scheduleDemoAppointments(
      ctx,
      bookingId,
      {
        outbound: { startAt: ctx.clock.at(-2, 18, 0) },
        inbound: { startAt: ctx.clock.at(2, 11, 0) },
      },
      acceptedAt,
    );
    await confirmDemoBooking(ctx, bookingId, 'send', acceptedAt);
    await issueDemoBooking(ctx, bookingId, [DEMO_MACHINES.rentalActive], issuedAt);
    await ctx.register(DEMO_SEED_KEYS.processRentalActive, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.appointmentReturnPlanned, 'appointment', inboundId);
    await ctx.register(
      DEMO_SEED_KEYS.machineRented,
      'machine',
      await machineIdByCode(ctx.db, DEMO_MACHINES.rentalActive),
    );
  },
};

/**
 * Rückgabe fällig heute (Lieferung): ausgegeben vor drei Tagen, Rückholung
 * heute in einem Zeitfenster, das sicher noch nicht überfällig ist – zugleich
 * Stopp der heutigen Tour.
 */
export const returnDueScenario: DemoScenario = {
  name: 'process.return.due',
  async run(ctx) {
    const acceptedAt = ctx.clock.at(-6, 14, 0);
    const issuedAt = ctx.clock.at(-3, 11, 0);
    const collectionFrom = ctx.clock.laterToday(16, 1);
    const collectionToCandidate = new Date(collectionFrom.getTime() + 2 * 3_600_000);
    const endOfDay = ctx.clock.at(0, 23, 59);
    const collectionTo =
      collectionToCandidate.getTime() <= endOfDay.getTime() ? collectionToCandidate : endOfDay;
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.returnDue);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: -1,
        guestCount: 50,
        occasion: 'birthday',
        machineSlug: 'slush-1x10',
        fulfillment: 'delivery',
        delivery: DEMO_ADDRESSES.lieferweg12,
        deliveryWindow: { from: ctx.clock.at(-3, 10, 0), to: ctx.clock.at(-3, 12, 0) },
        selections: [{ slug: 'sirup-waldmeister', role: 'free', quantity: 1 }],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId, { deliveryPriceCents: 2500 });
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    const { inboundId } = await scheduleDemoAppointments(
      ctx,
      bookingId,
      {
        inbound: {
          startAt: collectionFrom,
          endAt: collectionTo.getTime() > collectionFrom.getTime() ? collectionTo : null,
        },
      },
      acceptedAt,
    );
    await confirmDemoBooking(ctx, bookingId, 'send', acceptedAt);
    await issueDemoBooking(ctx, bookingId, [DEMO_MACHINES.returnDue], issuedAt);
    await ctx.register(DEMO_SEED_KEYS.processReturnDue, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.appointmentReturnDueToday, 'appointment', inboundId);
  },
};

/** Überfällige Rückgabe: Rückgabetermin gestern 11:00, Maschine noch ausgegeben. */
export const returnOverdueScenario: DemoScenario = {
  name: 'process.return.overdue',
  async run(ctx) {
    const acceptedAt = ctx.clock.at(-9, 9, 0);
    const issuedAt = ctx.clock.at(-5, 18, 10);
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.returnOverdue);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: -2,
        guestCount: 90,
        occasion: 'club',
        machineSlug: 'slush-1x10',
        fulfillment: 'pickup',
        selections: [
          { slug: 'sirup-blaue-himbeere', role: 'free', quantity: 1 },
          { slug: 'mischkanister-6l', role: 'extra', quantity: 1 },
        ],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId);
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    const { inboundId } = await scheduleDemoAppointments(
      ctx,
      bookingId,
      {
        outbound: { startAt: ctx.clock.at(-5, 18, 0) },
        inbound: { startAt: ctx.clock.at(-1, 11, 0) },
      },
      acceptedAt,
    );
    await confirmDemoBooking(ctx, bookingId, 'send', acceptedAt);
    await issueDemoBooking(ctx, bookingId, [DEMO_MACHINES.returnOverdue], issuedAt);
    await ctx.register(DEMO_SEED_KEYS.processReturnOverdue, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.appointmentReturnOverdue, 'appointment', inboundId);
  },
};
