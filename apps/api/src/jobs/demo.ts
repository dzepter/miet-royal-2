import type { Database } from '@mietroyal/database';
import { SYSTEM_HEARTBEAT_JOB_TYPE, type JobBeforeRunHook } from '@mietroyal/integrations';
import { DemoDatasetService } from '../demo/dataset.ts';
import {
  createDemoResetGate,
  DEMO_RESET_GATE_CACHE_TTL_MS,
  type DemoResetGate,
  type DemoResetGateLogger,
} from '../demo/reset-gate.ts';

/**
 * Phase 14 (Design §7, Worker): Reset-Guard für den Job-Runner – derselbe
 * Zustand wie das 503-Gate der API (`demo_dataset_state.reset_in_progress`,
 * In-Process-Cache 1 s). Läuft ein Demo-Reset, wird jeder Business-Job um
 * 15 s zurückgelegt, ohne einen Versuch zu verbrauchen. Ausgenommen ist nur
 * `system.heartbeat` (Infrastruktur ohne Fachdaten); der Scanner
 * `communication.scan_due` wartet bewusst ebenfalls.
 */

export const DEMO_JOB_DEFER_MS = 15_000;
export const DEMO_RESET_EXEMPT_JOB_TYPES: ReadonlySet<string> = new Set([
  SYSTEM_HEARTBEAT_JOB_TYPE,
]);

export { createDemoResetGate, DemoDatasetService };
export type { DemoResetGate };

export function createDemoJobGuard(
  gate: Pick<DemoResetGate, 'isResetInProgress'>,
  options: { deferMs?: number; exemptJobTypes?: ReadonlySet<string> } = {},
): JobBeforeRunHook {
  const deferMs = options.deferMs ?? DEMO_JOB_DEFER_MS;
  const exempt = options.exemptJobTypes ?? DEMO_RESET_EXEMPT_JOB_TYPES;
  return async (job) => {
    if (exempt.has(job.type)) return 'run';
    if (!(await gate.isResetInProgress())) return 'run';
    return { defer: { delayMs: deferMs, reason: 'DEMO_RESET' } };
  };
}

/** Komfort für `apps/worker`: Guard auf einem eigenen Gate über die Worker-DB. */
export function createDemoWorkerGuard(deps: {
  db: Database;
  logger?: DemoResetGateLogger;
}): JobBeforeRunHook {
  const gate = createDemoResetGate({
    dataset: new DemoDatasetService(deps.db),
    cacheTtlMs: DEMO_RESET_GATE_CACHE_TTL_MS,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  return createDemoJobGuard(gate);
}
