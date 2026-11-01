/**
 * Phase 14 (SEED): Test-Hilfen für Demo-Seed und Demo-Reset – Demo-Kontext
 * (APP_ENV=demo, FakeMailGateway, FS-Storage), vollständige Leerung der
 * Testdatenbank (Business + Staff + Demo-Zustand) und Service-Instanzen, die
 * an den Test-Kontext gebunden sind (dieselben Fakes wie die App).
 */
import { berlinDateOf, berlinDateTimeToUtc } from '@mietroyal/domain';
import type pg from 'pg';
import { DemoDatasetService } from '../src/demo/dataset.ts';
import { DemoSeedRegistry } from '../src/demo/registry.ts';
import { DemoResetService, type DemoResetServiceDeps } from '../src/demo/reset-service.ts';
import { DemoSeedService, type DemoSeedServiceDeps } from '../src/demo/seed/seed-service.ts';
import { createDemoSeedServices, type DemoSeedServices } from '../src/demo/seed/services.ts';
import {
  bootstrapAdmin,
  createTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { truncateHandoverTables } from './handover-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { truncateSettlementTables } from './settlement-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

/**
 * Bezugspunkt der Tests (injiziertes „jetzt“, Order §12): der echte Zeitpunkt
 * des Testlaufs, auf die Minute gerundet. Bewusst NICHT in die Vergangenheit
 * verschoben – Konfigurationszeitstempel (z. B. `pickup_exact_address`) tragen
 * die echte Uhrzeit, und ein älteres `now` würde die frisch berechnete Tour-
 * Route sofort als veraltet erscheinen lassen. Verschiebungen in die Zukunft
 * (zweiter Seed mit `now + 7 Tage`) sind dagegen unkritisch.
 */
export function demoTestNow(): Date {
  const at = new Date();
  at.setSeconds(0, 0);
  return at;
}

/** Zeitpunkt „HH:MM Berlin“ an einem Tag relativ zum Bezugspunkt. */
export function berlinAtFrom(now: Date, offsetDays: number, hour: number, minute = 0): Date {
  const [y, m, d] = berlinDateOf(now).split('-').map(Number);
  const dayIso = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + offsetDays))
    .toISOString()
    .slice(0, 10);
  return berlinDateTimeToUtc(dayIso, hour, minute);
}

export async function createDemoTestContext(): Promise<TestContext> {
  return createTestContext({ appEnv: 'demo' });
}

/**
 * Testdatenbank vollständig leeren (Business-, Staff-, Demo-, Job- und
 * Gerätetabellen) und die Vorgangsnummern-Sequenz neu starten. Nur Tests.
 */
export async function wipeDemoTestDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE demo_seed_entities, demo_dataset_state CASCADE');
  await pool.query(
    'TRUNCATE tour_delay_incidents, tour_live_locations, tour_stops, tours, geocoding_cache CASCADE',
  );
  await truncateCommunicationTables(pool);
  await truncateSettlementTables(pool);
  await truncateHandoverTables(pool);
  await resetWarehouse(pool);
  await truncateSchedulingTables(pool);
  await truncateCrmTables(pool);
  await truncateAuthTables(pool);
  await truncateCommerceTables(pool);
  await pool.query(
    `TRUNCATE push_deliveries, push_subscriptions, calendar_feed_tokens, offline_access_leases,
     offline_mutation_receipts, appointment_conflict_suppressions, lexware_webhook_events,
     booking_customer_contacts, appointment_reminders CASCADE`,
  );
  await pool.query('ALTER SEQUENCE process_number_seq RESTART WITH 1');
}

export interface DemoTestServices {
  services: DemoSeedServices;
  dataset: DemoDatasetService;
  registry: DemoSeedRegistry;
  seed: DemoSeedService;
  reset: DemoResetService;
}

/** Seed-/Reset-Services mit den Fakes des Kontexts (FakeMailGateway ⇒ Whitelist-Pfad der Outbox). */
export function demoServicesFor(
  ctx: TestContext,
  overrides: Partial<Pick<DemoSeedServiceDeps, 'config' | 'scenarios'>> &
    Partial<
      Pick<
        DemoResetServiceDeps,
        'hooks' | 'fkRetryDelayMs' | 'barrierTimeoutMs' | 'wipeLockTimeoutMs'
      >
    > = {},
): DemoTestServices {
  const config = overrides.config ?? ctx.config;
  const base = {
    db: ctx.db,
    config,
    storage: ctx.storage,
    queue: ctx.queue,
    mailGateway: ctx.mailGateway,
  };
  const dataset = new DemoDatasetService(ctx.db);
  const registry = new DemoSeedRegistry(ctx.db);
  const services = createDemoSeedServices({ ...base, staffMail: ctx.mail });
  const seed = new DemoSeedService({
    ...base,
    dataset,
    registry,
    services,
    ...(overrides.scenarios === undefined ? {} : { scenarios: overrides.scenarios }),
  });
  const reset = new DemoResetService({
    ...base,
    dataset,
    registry,
    seed,
    // Phase 14 Final (Reset-Barrier): dieselbe Barrier wie App/Test-Runner des Kontexts.
    ...(ctx.demoBarrier === null ? {} : { barrier: ctx.demoBarrier }),
    ...(overrides.barrierTimeoutMs === undefined
      ? {}
      : { barrierTimeoutMs: overrides.barrierTimeoutMs }),
    // Phase 14 Final (Härtung): lock_timeout der Phase B (Tests setzen kleine Werte).
    ...(overrides.wipeLockTimeoutMs === undefined
      ? {}
      : { wipeLockTimeoutMs: overrides.wipeLockTimeoutMs }),
    // Review F4: Retry-Pause in Tests 0 (Zeit); produktiv greift der Default.
    fkRetryDelayMs: overrides.fkRetryDelayMs ?? 0,
    ...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
  });
  return { services, dataset, registry, seed, reset };
}

/** Leere DB + Bootstrap-Admin (Systemadmin, nie vom Seed angelegt). */
export async function freshDemoDatabase(ctx: TestContext): Promise<{ adminId: string }> {
  await wipeDemoTestDatabase(ctx.pool);
  const admin = await bootstrapAdmin(ctx);
  return { adminId: admin.id };
}
