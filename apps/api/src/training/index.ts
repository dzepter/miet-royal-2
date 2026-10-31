/**
 * Phase 14 (Training, W2): öffentliche Oberfläche des Trainingsmoduls –
 * Katalog (Code), Evaluatoren, Recorder-Boundary, Service, Katalog-Sync.
 * Gate-Service/-HTTP (Live-Sperren) liegen in `gate-service.ts`/`gate-http.ts`.
 */
export {
  TRAINING_CATALOG,
  TRAINING_DEFINITIONS,
  TRAINING_FEATURES,
  TRAINING_PATHS,
  definitionOrderIndex,
  definitionSpecFor,
  hasRequiredPermissions,
  type TrainingCatalog,
  type TrainingDefinitionSpec,
  type TrainingFeatureKey,
  type TrainingFeatureSpec,
  type TrainingPathItemSpec,
  type TrainingPathSpec,
  type TrainingPermissionRequirement,
} from './catalog.ts';
export {
  TRAINING_CATALOG_SYNC_LOCK_KEY,
  TrainingCatalogService,
  validateTrainingCatalog,
} from './catalog-sync.ts';
export { TRAINING_ERROR_CODES, TRAINING_MESSAGES, TrainingError } from './errors.ts';
export { TRAINING_EVENT_KEYS, isTrainingEventKey, type TrainingEventKey } from './event-keys.ts';
export {
  EVALUATOR_ERROR_CODES,
  EVALUATOR_KEYS,
  TRAINING_EVALUATORS,
  evaluatorAcceptsEvent,
  evaluatorFor,
  isComplete,
  isEvaluatorKey,
  matchEvent,
  openStep,
  stepsView,
  type AcceptedEvent,
  type EvaluatorKey,
  type EvaluatorSpec,
  type EvaluatorStep,
  type IncomingEvent,
  type MatchResult,
} from './evaluators.ts';
export { createTrainingMailSentListener } from './listeners.ts';
export { refreshAssignmentProgress, refreshAssignmentsForDefinition } from './progress.ts';
export {
  DemoTrainingEventRecorder,
  acceptedEventsFor,
  createNoopTrainingRecorder,
  type TrainingEventInput,
  type TrainingEventRecorder,
  type TrainingRecordOutcome,
  type TrainingRecorderLogger,
} from './recorder.ts';
export {
  DEMO_RESET_INTERRUPTION_CODE,
  TRAINING_RESET_INTERRUPTION_CODE,
  TrainingService,
  interruptInProgressAttempts,
  type SeedEntityResolver,
  type TrainingAdminAttemptView,
  type TrainingAdminUserDetail,
  type TrainingAdminUserOverview,
  type TrainingAssignmentItemView,
  type TrainingAssignmentView,
  type TrainingAttemptEventView,
  type TrainingAttemptView,
  type TrainingCatalogPathView,
  type TrainingDefinitionProgressView,
  type TrainingDefinitionView,
  type TrainingItemState,
  type TrainingOverview,
  type TrainingResetResult,
  type TrainingServiceDeps,
  type TrainingStepView,
  type TrainingUserRef,
} from './training-service.ts';
