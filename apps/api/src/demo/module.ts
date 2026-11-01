import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StaffAuthService } from '../auth/service.ts';
import { DemoDatasetService } from './dataset.ts';
import { DemoSeedRegistry } from './registry.ts';
import { DemoResetBarrier } from './reset-barrier.ts';
import {
  createDemoResetGate,
  DEMO_RESET_GATE_CACHE_TTL_MS,
  type DemoResetGate,
} from './reset-gate.ts';
import { DemoError, type DemoResetRunner } from './types.ts';

/**
 * Phase 14 (Design §2): Komposition des Demo-Moduls – Dataset-Zustand,
 * Seed-Registry, Reset-Runner und Reset-Gate. Wird in `buildApp` NUR für
 * `APP_ENV=demo` erzeugt (in allen anderen Umgebungen existieren weder Gate
 * noch Demo-Routen). Der Reset selbst (Löschen + kanonischer Seed) liegt in
 * `reset-service.ts` (Agent SEED); solange die Datei fehlt, antwortet ein
 * Stub mit `DemoError('CONFLICT','DEMO_RESET_UNAVAILABLE')`.
 */

export interface DemoModuleLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface DemoModuleDeps {
  db: Database;
  config: AppConfig;
  auth: StaffAuthService;
  logger: DemoModuleLogger;
  /** Test-Injection bzw. Reset-Service (SEED); Default: Stub „noch nicht verfügbar“. */
  reset?: DemoResetRunner;
  /**
   * Phase 14 Final (Reset-Barrier): Test-Injection der Barrier (Default: eigene
   * Instanz mit eigenem Lock-Pool auf `config.databaseUrl`). `buildApp`
   * schließt die Barrier des Moduls beim `onClose` (idempotent).
   */
  barrier?: DemoResetBarrier;
}

export interface DemoModule {
  dataset: DemoDatasetService;
  registry: DemoSeedRegistry;
  reset: DemoResetRunner;
  gate: DemoResetGate;
  /** Phase 14 Final: verteilte Reset-Barrier (Shared für Mutationen/Jobs, Exclusive für den Reset). */
  barrier: DemoResetBarrier;
}

export const DEMO_RESET_UNAVAILABLE_CODE = 'DEMO_RESET_UNAVAILABLE';

/** Stub, bis `reset-service.ts` (Agent SEED) eingehängt ist. */
export function createUnavailableResetRunner(): DemoResetRunner {
  return {
    reset: async () => {
      throw new DemoError(
        'CONFLICT',
        DEMO_RESET_UNAVAILABLE_CODE,
        'Reset ist noch nicht verfügbar.',
      );
    },
  };
}

export function createDemoModule(deps: DemoModuleDeps): DemoModule {
  if (deps.config.appEnv !== 'demo') {
    // Order §15: Reset/Status existieren ausschließlich in der Demo-Umgebung.
    throw new DemoError('FORBIDDEN', 'DEMO_ONLY', 'Nur in der Demo-Umgebung verfügbar.');
  }
  const dataset = new DemoDatasetService(deps.db);
  const registry = new DemoSeedRegistry(deps.db);
  const gate = createDemoResetGate({
    dataset,
    cacheTtlMs: DEMO_RESET_GATE_CACHE_TTL_MS,
    logger: deps.logger,
  });
  const reset = deps.reset ?? createUnavailableResetRunner();
  // Phase 14 Final (Reset-Barrier): eigener Lock-Pool, getrennt vom Fach-Pool.
  const barrier =
    deps.barrier ??
    new DemoResetBarrier({ databaseUrl: deps.config.databaseUrl, logger: deps.logger });
  return { dataset, registry, reset, gate, barrier };
}
