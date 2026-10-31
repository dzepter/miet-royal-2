import type { DemoScenario } from '../context.ts';
import { DEMO_MACHINE_BLOCK_REASON, DEMO_MACHINES, DEMO_SEED_KEYS } from '../data.ts';
import { machineIdByCode } from './builders.ts';

/**
 * Maschinenzustände (Order §10/§11): „gesperrt mit Grund“ über
 * MachineService.createBlock (Zeitraum + Pflichtgrund) auf einer Maschine in
 * Reparatur (manueller Status). Reserviert/Vermietet/Reinigung entstehen nur
 * in den Fachabläufen (Vorbereitung, Übergabe, Rückgabe) und sind dort
 * registriert; einsatzbereit = Grundzustand aller übrigen Seed-Maschinen.
 */
export const machinesScenario: DemoScenario = {
  name: 'machines',
  async run(ctx) {
    const machineId = await machineIdByCode(ctx.db, DEMO_MACHINES.blocked);
    await ctx.services.machines.setStatus(machineId, 'repair', ctx.now);
    await ctx.services.machines.createBlock(machineId, ctx.actorId, {
      startsAt: ctx.clock.at(0, 8, 0),
      endsAt: ctx.clock.at(14, 18, 0),
      reason: DEMO_MACHINE_BLOCK_REASON,
    });
    await ctx.register(DEMO_SEED_KEYS.machineBlocked, 'machine', machineId);
  },
};

/**
 * Nachlauf: zeitabgeleitete Hinweise sofort materialisieren (Überfälligkeits-
 * Incident des überfälligen Rückgabetermins, Risikohinweise der Zuweisungen) –
 * dieselben Service-Pfade, die sonst lazy beim Lesen laufen.
 */
export const finishingScenario: DemoScenario = {
  name: 'finishing',
  async run(ctx) {
    await ctx.services.scheduling.ensureOverdueIncidents(ctx.now);
    await ctx.services.assignments.refreshRiskIncidents(ctx.now);
  },
};
