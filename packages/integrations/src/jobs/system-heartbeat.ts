import type { ClaimedJob } from './queue.ts';

/**
 * Harmloser System-Job, der die Queue-Infrastruktur beweist
 * (PHASE_00_FOUNDATION.md, Deliverable 7). Kein Fachjob.
 */
export const SYSTEM_HEARTBEAT_JOB_TYPE = 'system.heartbeat';

export async function systemHeartbeatHandler(_job: ClaimedJob): Promise<void> {
  // Bewusst leer: Erfolg des Jobs beweist enqueue → claim → process.
}
