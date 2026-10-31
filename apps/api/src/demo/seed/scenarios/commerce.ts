import type { DemoScenario } from '../context.ts';
import { DEMO_ADDRESSES, DEMO_CUSTOMERS, DEMO_MACHINES, DEMO_SEED_KEYS } from '../data.ts';
import {
  acceptDemoOffer,
  appointmentsOf,
  assignDemoMachines,
  confirmDemoBooking,
  createDemoCustomer,
  createDemoDraft,
  createDemoProcess,
  machineIdByCode,
  scheduleDemoAppointments,
  sendDemoOffer,
} from './builders.ts';

/** Neue Anfrage: offener Vorgang mit Anfrage, ohne Angebot (Privatkunde). */
export const inquiryNewScenario: DemoScenario = {
  name: 'process.inquiry.new',
  async run(ctx) {
    const customerId = await ctx.resolve(DEMO_SEED_KEYS.customerPrivateBasic);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 21,
        guestCount: 35,
        occasion: 'birthday',
        machineSlug: 'slush-1x10',
        fulfillment: 'pickup',
        selections: [{ slug: 'sirup-kirsche', role: 'free', quantity: 1 }],
      },
    });
    await ctx.register(DEMO_SEED_KEYS.processInquiryNew, 'process', processId);
  },
};

/** Angebotsentwurf (Organisation, Lieferung mit manuellem Lieferpreis, Zusatzartikel). */
export const offerDraftScenario: DemoScenario = {
  name: 'process.offer.draft',
  async run(ctx) {
    const customerId = await ctx.resolve(DEMO_SEED_KEYS.customerOrgBasic);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 28,
        guestCount: 120,
        occasion: 'club',
        machineSlug: 'slush-2x10',
        fulfillment: 'delivery',
        delivery: DEMO_ADDRESSES.vereinsstrasse,
        selections: [
          { slug: 'sirup-waldmeister', role: 'free', quantity: 2 },
          { slug: 'sirup-blaue-himbeere', role: 'extra', quantity: 2 },
          { slug: 'mischkanister-6l', role: 'extra', quantity: 2 },
        ],
        onsiteContactName: 'Jonas Vorstand',
      },
    });
    await createDemoDraft(ctx, processId, { deliveryPriceCents: 4500 });
    await ctx.register(DEMO_SEED_KEYS.processOfferDraft, 'process', processId);
  },
};

/**
 * Versendetes Angebot: Mail liegt in der Outbox – in der Demo ohne Whitelist-
 * Eintrag als `blocked` (DEMO_NOT_WHITELISTED) bzw. ohne SMTP als
 * `blocked` (MAIL_NOT_CONFIGURED); das Angebot ist fachlich trotzdem „versendet“.
 */
export const offerSentScenario: DemoScenario = {
  name: 'process.offer.sent',
  async run(ctx) {
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.offerSent);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 10,
        guestCount: 25,
        occasion: 'party',
        machineSlug: 'slush-1x8',
        fulfillment: 'pickup',
        selections: [{ slug: 'sirup-wassermelone', role: 'free', quantity: 1 }],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId);
    await sendDemoOffer(ctx, versionId, ctx.now);
    await ctx.register(DEMO_SEED_KEYS.processOfferSent, 'process', processId);
  },
};

/**
 * Angenommene Buchung (Selbstabholung): Abholtermin geplant, Rückgabetermin
 * bewusst ungeplant (Übungsaufgabe), AB nur vorbereitet, Maschine bereits
 * zugeordnet, aber nicht vorbereitet (Maschinenzustand „zugeordnet“).
 */
export const bookingAcceptedPickupScenario: DemoScenario = {
  name: 'process.booking.accepted.pickup',
  async run(ctx) {
    const acceptedAt = ctx.clock.hoursAgo(26);
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.bookingPickup);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 12,
        guestCount: 60,
        occasion: 'wedding',
        machineSlug: 'slush-2x8',
        fulfillment: 'pickup',
        selections: [
          { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
          { slug: 'sirup-wassermelone', role: 'free', quantity: 1 },
          { slug: 'strohhalme-25', role: 'extra', quantity: 1 },
        ],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId);
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    const { inboundId } = await scheduleDemoAppointments(
      ctx,
      bookingId,
      { outbound: { startAt: ctx.clock.at(11, 18, 0) } },
      acceptedAt,
    );
    await assignDemoMachines(ctx, bookingId, [DEMO_MACHINES.assigned], ctx.now);
    await ctx.register(DEMO_SEED_KEYS.processBookingAcceptedPickup, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.appointmentReturnUnplanned, 'appointment', inboundId);
    await ctx.register(
      DEMO_SEED_KEYS.machineAssigned,
      'machine',
      await machineIdByCode(ctx.db, DEMO_MACHINES.assigned),
    );
  },
};

/**
 * Angenommene Buchung (Lieferung): Adress-Snapshot der Buchung, Lieferfenster
 * heute (Stopp der heutigen Tour), Rückholung in zwei Tagen, AB freigegeben
 * und versendet.
 */
export const bookingAcceptedDeliveryScenario: DemoScenario = {
  name: 'process.booking.accepted.delivery',
  async run(ctx) {
    const acceptedAt = ctx.clock.at(-3, 9, 30);
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.bookingDelivery);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 1,
        guestCount: 80,
        occasion: 'school_kindergarten',
        machineSlug: 'slush-2x10',
        fulfillment: 'delivery',
        delivery: DEMO_ADDRESSES.lieferweg12,
        deliveryWindow: { from: ctx.clock.at(0, 10, 0), to: ctx.clock.at(0, 12, 0) },
        collectionWindow: { from: ctx.clock.at(2, 10, 0), to: ctx.clock.at(2, 12, 0) },
        selections: [
          { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
          { slug: 'sirup-waldmeister', role: 'free', quantity: 1 },
          { slug: 'becher-25', role: 'extra', quantity: 2 },
        ],
        onsiteContactName: 'Sandra Leitung',
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId, { deliveryPriceCents: 2500 });
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    await confirmDemoBooking(ctx, bookingId, 'send', acceptedAt);
    const { outbound } = await appointmentsOf(ctx.db, bookingId);
    await ctx.register(DEMO_SEED_KEYS.processBookingAcceptedDelivery, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.appointmentDeliveryToday, 'appointment', outbound.id);
  },
};

/**
 * Zweite Lieferung heute (Privatkunde) – Lieferadresse im Routing-Mock bewusst
 * mehrdeutig („Am Markt 1, 55116 Mainz“ ⇒ Adressprüfung in der Tourenplanung);
 * AB noch nicht freigegeben (Übungsaufgabe).
 */
export const deliverySecondScenario: DemoScenario = {
  name: 'process.booking.accepted.delivery_second',
  async run(ctx) {
    const acceptedAt = ctx.clock.at(-2, 16, 0);
    const customerId = await createDemoCustomer(ctx, DEMO_CUSTOMERS.deliverySecond);
    const { processId } = await createDemoProcess(ctx, {
      customerId,
      source: 'website',
      assignToActor: true,
      inquiry: {
        eventInDays: 1,
        guestCount: 40,
        occasion: 'party',
        machineSlug: 'slush-1x10',
        fulfillment: 'delivery',
        delivery: DEMO_ADDRESSES.amMarkt,
        deliveryWindow: { from: ctx.clock.at(0, 14, 0), to: ctx.clock.at(0, 16, 0) },
        collectionWindow: { from: ctx.clock.at(2, 16, 0), to: ctx.clock.at(2, 18, 0) },
        selections: [{ slug: 'sirup-blaue-himbeere', role: 'free', quantity: 1 }],
      },
    });
    const { versionId } = await createDemoDraft(ctx, processId, { deliveryPriceCents: 1500 });
    const { token } = await sendDemoOffer(ctx, versionId, acceptedAt);
    const { bookingId } = await acceptDemoOffer(ctx, token, acceptedAt);
    const { outbound } = await appointmentsOf(ctx.db, bookingId);
    await ctx.register(DEMO_SEED_KEYS.processDeliverySecond, 'process', processId);
    await ctx.register(DEMO_SEED_KEYS.appointmentDeliveryTodaySecond, 'appointment', outbound.id);
  },
};
