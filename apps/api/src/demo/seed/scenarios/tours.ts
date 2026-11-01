import type { DemoScenario } from '../context.ts';
import { DEMO_SEED_KEYS } from '../data.ts';

/**
 * Touren (Order §10, Phase 13): Tour HEUTE mit mehreren Stopps (zwei
 * Lieferungen, eine Rückholung) als „bereit“ markiert, NICHT gestartet – der
 * Fahrer ist der Fachaktor. Tour MORGEN als Entwurf mit der vorbereiteten
 * Lieferung und einer über den Routing-Mock berechneten Route (Planung über
 * PlanningService.propose/apply – kein Provider-Aufruf in der Demo).
 */
export const toursScenario: DemoScenario = {
  name: 'tours',
  async run(ctx) {
    const { tours, planning } = ctx.services;

    const today = await tours.create(
      ctx.actorId,
      { tourDate: ctx.clock.todayIso, assignedUserId: ctx.actorId },
      ctx.now,
    );
    for (const key of [
      DEMO_SEED_KEYS.appointmentDeliveryToday,
      DEMO_SEED_KEYS.appointmentDeliveryTodaySecond,
      DEMO_SEED_KEYS.appointmentReturnDueToday,
    ]) {
      const appointmentId = await ctx.resolve(key);
      await tours.addStop(ctx.actorId, today.id, { appointmentId }, ctx.effective, ctx.now);
    }
    await tours.markReady(ctx.actorId, today.id, {}, ctx.now);
    await ctx.register(DEMO_SEED_KEYS.tourTodayMultiStop, 'tour', today.id);

    const tomorrow = await tours.create(
      ctx.actorId,
      { tourDate: ctx.clock.dayIso(1), assignedUserId: ctx.actorId },
      ctx.now,
    );
    const tomorrowStop = await ctx.resolve(DEMO_SEED_KEYS.appointmentDeliveryTomorrow);
    await tours.addStop(
      ctx.actorId,
      tomorrow.id,
      { appointmentId: tomorrowStop },
      ctx.effective,
      ctx.now,
    );
    // Routenberechnung mit dem späteren von `now` und Echtzeit: Die Depot-
    // Einstellung (pickup_exact_address) trägt den ECHTEN Schreibzeitpunkt,
    // und eine Route, die davor „berechnet“ wäre, gälte sofort als veraltet
    // (Stale-Regel der Touren). Die Tourdaten selbst bleiben relativ zu `now`.
    const planningNow = new Date(Math.max(ctx.now.getTime(), Date.now()));
    const proposal = await planning.propose(tomorrow.id, {}, planningNow);
    if (proposal.status === 'ok') {
      await planning.apply(
        tomorrow.id,
        ctx.actorId,
        { expectedVersion: proposal.version, order: proposal.plan.order },
        planningNow,
      );
    }
    await ctx.register(DEMO_SEED_KEYS.tourFuturePlanned, 'tour', tomorrow.id);
  },
};
