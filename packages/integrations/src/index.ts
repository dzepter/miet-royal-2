// Jobs (PostgreSQL-Queue mit Retry + Idempotenz)
export {
  type ClaimedJob,
  type EnqueueOptions,
  type EnqueueResult,
  type JobQueue,
  type ReclaimResult,
} from './jobs/queue.ts';
export { PostgresJobQueue, DEFAULT_LEASE_MS } from './jobs/postgres-queue.ts';
export { computeBackoffMs } from './jobs/backoff.ts';
export {
  JobRunner,
  summarizeJobError,
  type JobHandler,
  type JobRunnerLogger,
  type JobBeforeRunDecision,
  type JobBeforeRunHook,
  // Phase 14 Final (Reset-Barrier): Execution-Guard um die gesamte Jobausführung.
  JOB_EXECUTION_GUARD_ERROR_DEFER_MS,
  type JobExecutionDecision,
  type JobExecutionGuard,
} from './jobs/runner.ts';
export { SYSTEM_HEARTBEAT_JOB_TYPE, systemHeartbeatHandler } from './jobs/system-heartbeat.ts';

// Storage (privater Objektspeicher hinter Interface)
export {
  type StorageProvider,
  type PutOptions,
  StorageObjectNotFoundError,
  InvalidStorageKeyError,
  assertValidStorageKey,
} from './storage/storage.ts';
export { S3StorageProvider } from './storage/s3-storage.ts';
export { FilesystemStorageProvider } from './storage/fs-storage.ts';
export { createStorageProvider } from './storage/factory.ts';
