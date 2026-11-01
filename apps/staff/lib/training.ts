'use client';

import { apiFetch, type ApiResult } from './api';

/**
 * Phase 14 (Training, Design Teil 2 §§4.4–4.6): Typen, Fetch-Wrapper und
 * Textbausteine für die Trainingsseiten der Staff-App. Übungen (Versuche,
 * Zuweisungen) existieren nur in der Demo; Live kennt ausschließlich den
 * Katalog, Live-Sperren, Freigaben und Overrides (Order W2). Texte zentral,
 * damit Seiten, Navigation und Offline-Konfliktanzeige überall gleich heißen
 * (UX_RULES „Sprache“) – nie rohe Codes in der Oberfläche.
 */

export type TrainingEnvironment = 'development' | 'staging' | 'demo' | 'production';
export type TrainingAttemptStatus = 'in_progress' | 'passed' | 'interrupted';
export type TrainingAssignmentStatus = 'assigned' | 'in_progress' | 'completed';
export type TrainingExerciseState = 'passed' | 'in_progress' | 'open';
export type TrainingClearanceSource = 'verified_demo' | 'override';
export type TrainingEventResult =
  'accepted' | 'duplicate' | 'rejected' | 'check_passed' | 'check_failed' | 'interrupted';

export interface TrainingStepRef {
  key: string;
  title: string;
}

export interface TrainingSeedEntityRef {
  entityType: string;
  entityId: string;
}

export interface DefinitionView {
  key: string;
  version: number;
  title: string;
  objective: string;
  instructions: string;
  active: boolean;
  demoPath: string | null;
  seedKey: string | null;
  /** Nur in der Demo aufgelöst (Seed-Registry, §72); sonst null. */
  seedEntity: TrainingSeedEntityRef | null;
  steps: TrainingStepRef[];
  /** Dem angemeldeten Mitarbeiter fehlt ein Fachrecht der Übung (§55). */
  permissionMissing: boolean;
}

export interface AttemptStepView extends TrainingStepRef {
  done: boolean;
}

export interface AttemptView {
  id: string;
  definitionKey: string;
  status: TrainingAttemptStatus;
  startedAt: string;
  completedAt: string | null;
  interruptedAt: string | null;
  interruptionCode: string | null;
  failedCheckCount: number;
  lastFailedCheckAt: string | null;
  steps: AttemptStepView[];
  openStep: TrainingStepRef | null;
  assignmentId: string | null;
}

/**
 * Katalog-Übung mit Fortschritt des angemeldeten Mitarbeiters (Server
 * `definitionsView`, Review-Fix F7): Zustand/Bestehen auch für Übungen ohne
 * Zuweisung – bestanden bleibt nach Reload bestanden.
 */
export interface DefinitionProgressView extends DefinitionView {
  state: TrainingExerciseState;
  passedAt: string | null;
  /** Laufender Versuch, sonst der jüngste nicht supersedierte Versuch (auch unterbrochen). */
  attempt: AttemptView | null;
}

export interface AttemptEventView {
  eventKey: string;
  stepKey: string | null;
  result: TrainingEventResult;
  errorCode: string | null;
  occurredAt: string;
}

export interface AssignmentItemView {
  sequence: number;
  required: boolean;
  definition: DefinitionView;
  state: TrainingExerciseState;
  passedAt: string | null;
  /** Aktueller Versuch der laufenden Runde (laufend, bestanden oder unterbrochen) – null ohne Versuch. */
  attempt: AttemptView | null;
}

export interface AssignmentView {
  id: string;
  path: { key: string; title: string; description: string };
  status: TrainingAssignmentStatus;
  assignedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  round: number;
  items: AssignmentItemView[];
}

/** Eigener Live-Sperrstatus je aktivierter Sperre (nur außerhalb der Demo; Server `gate-service.ts`). */
export interface GateStatusView {
  featureKey: string;
  /** Verständlicher Funktionsname, z. B. „Angebot senden“. */
  title: string;
  /** Sperre wird in dieser Umgebung erzwungen (nur production, §63). */
  enforced: boolean;
  requiredTraining: { key: string; title: string; active: boolean } | null;
  /** Aktive Sperre ohne gültige Übung – in production fail-closed (§97). */
  configurationInvalid: boolean;
  cleared: boolean;
  clearance: {
    id?: string;
    source: TrainingClearanceSource;
    validFrom?: string;
    validUntil: string | null;
  } | null;
}

export interface TrainingMe {
  environment: TrainingEnvironment;
  /** true nur in der Demo – dort laufen Übungen. */
  exercisesAvailable: boolean;
  assignments: AssignmentView[];
  /** Aktiver Katalog (freies Starten ohne Zuweisung) mit eigenem Zustand je Übung. */
  definitions: DefinitionProgressView[];
  activeAttempts: AttemptView[];
  gates: GateStatusView[];
}

/* ── Admin (training.manage) ───────────────────────────────────────────── */

export interface TrainingUserRef {
  id: string;
  firstName: string;
  lastName: string;
}

export interface AdminLastAttempt {
  status: TrainingAttemptStatus;
  failedCheckCount: number;
  lastFailedCheckAt: string | null;
  interruptionCode: string | null;
}

export interface AdminOverviewItem {
  definitionKey: string;
  title: string;
  state: TrainingExerciseState;
  lastAttempt: AdminLastAttempt | null;
}

export interface AdminOverviewAssignment {
  pathKey: string;
  pathTitle: string;
  status: TrainingAssignmentStatus;
  round: number;
  items: AdminOverviewItem[];
}

export interface AdminOverviewUser {
  user: TrainingUserRef;
  assignments: AdminOverviewAssignment[];
  interruptedAttempts: number;
  failedChecks: number;
}

export interface AdminAttemptDetail extends AttemptView {
  /** Titel der Übung (falls der Server ihn liefert; sonst Katalog-Lookup über definitionKey). */
  definitionTitle?: string;
  events: AttemptEventView[];
}

export interface AdminUserDetail {
  user?: TrainingUserRef;
  assignments: AssignmentView[];
  attempts: AdminAttemptDetail[];
}

export interface CatalogDefinitionRef {
  key: string;
  title: string;
  version: number;
  active: boolean;
}

export interface CatalogPathView {
  key: string;
  title: string;
  description: string;
  active: boolean;
  items: { sequence: number; required: boolean; definition: CatalogDefinitionRef }[];
}

export interface AdminCatalog {
  paths: CatalogPathView[];
  /** Optional: alle Definitionen (auch ohne Pfad). */
  definitions?: CatalogDefinitionRef[];
}

export interface TrainingResetResult {
  interruptedAttempts: number;
  supersededAttempts: number;
  resetAssignments: number;
}

export interface GateDefinitionRef {
  key: string;
  title: string;
  active: boolean;
}

export interface GateFeatureView {
  featureKey: string;
  title: string;
  description: string;
  requirement: {
    definitionKey: string;
    enabled: boolean;
    configuredAt: string;
    configuredBy: string | null;
  } | null;
  definition: GateDefinitionRef | null;
}

export interface GatesAdminView {
  environment?: TrainingEnvironment;
  /** Sperren werden nur in production erzwungen (§63) – sonst reine Konfiguration. */
  enforced?: boolean;
  features: GateFeatureView[];
  definitions: GateDefinitionRef[];
}

export interface ClearanceView {
  id: string;
  userId: string;
  /** null, wenn der Mitarbeiter nicht mehr auflösbar ist. */
  user: { firstName: string; lastName: string } | null;
  definitionKey: string;
  definitionTitle: string | null;
  source: TrainingClearanceSource;
  reason: string | null;
  validFrom: string;
  validUntil: string | null;
  grantedBy: string | null;
  grantedAt: string;
  revokedAt: string | null;
  revokedBy?: string | null;
  /** Gültig zum Abfragezeitpunkt (nicht widerrufen, begonnen, nicht abgelaufen). */
  active: boolean;
}

/* ── Fetch-Wrapper (Routen Design §4.4, Präfix /staff/training) ────────── */

export function fetchTrainingMe(): Promise<ApiResult<TrainingMe>> {
  return apiFetch<TrainingMe>('/staff/training/me');
}

export function fetchTrainingDefinitions(): Promise<
  ApiResult<{ definitions: DefinitionProgressView[] }>
> {
  return apiFetch('/staff/training/definitions');
}

export function startAttempt(definitionKey: string): Promise<ApiResult<{ attempt: AttemptView }>> {
  return apiFetch('/staff/training/attempts', { method: 'POST', body: { definitionKey } });
}

export function fetchAttempt(
  attemptId: string,
): Promise<ApiResult<{ attempt: AttemptView; events: AttemptEventView[] }>> {
  return apiFetch(`/staff/training/attempts/${attemptId}`);
}

export function checkAttempt(
  attemptId: string,
): Promise<ApiResult<{ attempt: AttemptView; passed: boolean; openStep: TrainingStepRef | null }>> {
  return apiFetch(`/staff/training/attempts/${attemptId}/check`, { method: 'POST' });
}

export function fetchAdminOverview(): Promise<ApiResult<{ users: AdminOverviewUser[] }>> {
  return apiFetch('/staff/training/admin/overview');
}

export function fetchAdminUserDetail(userId: string): Promise<ApiResult<AdminUserDetail>> {
  return apiFetch(`/staff/training/admin/users/${userId}`);
}

export function fetchAdminCatalog(): Promise<ApiResult<AdminCatalog>> {
  return apiFetch('/staff/training/admin/paths');
}

export function createAssignment(body: {
  userId: string;
  pathKey: string;
  dueAt?: string;
}): Promise<ApiResult<unknown>> {
  return apiFetch('/staff/training/admin/assignments', { method: 'POST', body });
}

export function resetTraining(body: {
  userId: string;
  pathKey?: string;
  definitionKey?: string;
}): Promise<ApiResult<TrainingResetResult>> {
  return apiFetch<TrainingResetResult>('/staff/training/admin/reset', { method: 'POST', body });
}

export function fetchGates(): Promise<ApiResult<GatesAdminView>> {
  return apiFetch<GatesAdminView>('/staff/training/admin/gates');
}

export function updateGate(
  featureKey: string,
  body: { definitionKey: string; enabled: boolean },
): Promise<ApiResult<{ feature: GateFeatureView }>> {
  return apiFetch(`/staff/training/admin/gates/${encodeURIComponent(featureKey)}`, {
    method: 'PUT',
    body,
  });
}

export function fetchClearances(
  userId?: string,
): Promise<ApiResult<{ clearances: ClearanceView[] }>> {
  const query = userId !== undefined ? `?userId=${encodeURIComponent(userId)}` : '';
  return apiFetch(`/staff/training/admin/clearances${query}`);
}

export function createClearance(body: {
  userId: string;
  definitionKey: string;
  source: TrainingClearanceSource;
  reason?: string;
  validUntil?: string;
}): Promise<ApiResult<{ clearance: ClearanceView; created: boolean }>> {
  return apiFetch('/staff/training/admin/clearances', { method: 'POST', body });
}

export function revokeClearance(
  clearanceId: string,
): Promise<ApiResult<{ clearance: ClearanceView; revoked: boolean }>> {
  return apiFetch(`/staff/training/admin/clearances/${clearanceId}/revoke`, { method: 'POST' });
}

/* ── Texte (UX_RULES „Training (Phase 14)“) ────────────────────────────── */

export const TRAINING_OFFLINE_TEXT = 'Training ist offline nicht verfügbar.';
export const TRAINING_DEMO_ONLY_TEXT = 'Übungen werden in der Demo-Umgebung absolviert.';
export const TRAINING_PERMISSION_MISSING_TEXT =
  'Für diese Übung fehlt dir aktuell die erforderliche Berechtigung.';
export const TRAINING_CHECK_PASSED_TEXT = 'Übung bestanden.';
export const TRAINING_RESET_HISTORY_HINT =
  'Historische Versuche bleiben erhalten; eine neue Runde beginnt.';
export const TRAINING_OVERRIDE_REASON_REQUIRED =
  'Für einen Override ist eine Begründung erforderlich.';
/** Fallback für 403 TRAINING_REQUIRED ohne Servertext (der Servertext nennt die Übung, §66). */
export const TRAINING_REQUIRED_FALLBACK_TEXT =
  'Für diese Funktion ist zuerst ein Training erforderlich.';
/** Wortlaut wie `TRAINING_GATE_MESSAGES.configurationInvalid` des Servers (gate-service.ts). */
export const TRAINING_CONFIGURATION_INVALID_TEXT =
  'Diese Funktion ist durch eine fehlerhaft konfigurierte Trainingssperre blockiert. Bitte wende dich an die Verwaltung.';

/** Ablehnungscodes der Live-Sperre (Fachaktionen und Offline-Sync). */
export const TRAINING_GATE_ERROR_CODES = ['TRAINING_REQUIRED', 'TRAINING_CONFIGURATION_INVALID'];

export function isTrainingGateErrorCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && TRAINING_GATE_ERROR_CODES.includes(code);
}

/** Text einer Gate-Ablehnung: Servertext (nennt die Übung) vor neutralem Fallback. */
export function trainingGateErrorText(code: string, serverMessage: string | null): string {
  if (serverMessage !== null && serverMessage.trim() !== '') return serverMessage;
  return code === 'TRAINING_CONFIGURATION_INVALID'
    ? TRAINING_CONFIGURATION_INVALID_TEXT
    : TRAINING_REQUIRED_FALLBACK_TEXT;
}

export function checkIncompleteText(openStep: TrainingStepRef | null): string {
  return openStep === null
    ? 'Noch nicht vollständig – bitte die Schritte der Übung abschließen.'
    : `Noch nicht vollständig – offener Schritt: ‚${openStep.title}‘.`;
}

export const ATTEMPT_STATUS_LABELS: Record<TrainingAttemptStatus, string> = {
  in_progress: 'läuft',
  passed: 'bestanden',
  interrupted: 'unterbrochen',
};

export const EXERCISE_STATE_LABELS: Record<TrainingExerciseState, string> = {
  passed: 'erledigt',
  in_progress: 'läuft',
  open: 'offen',
};

export const ASSIGNMENT_STATUS_LABELS: Record<TrainingAssignmentStatus, string> = {
  assigned: 'zugewiesen',
  in_progress: 'in Bearbeitung',
  completed: 'abgeschlossen',
};

export const CLEARANCE_SOURCE_LABELS: Record<TrainingClearanceSource, string> = {
  verified_demo: 'Demo bestätigt',
  override: 'Override',
};

export const EVENT_RESULT_LABELS: Record<TrainingEventResult, string> = {
  accepted: 'Schritt erledigt',
  duplicate: 'Schritt bereits erledigt',
  rejected: 'Schritt nicht angerechnet',
  check_passed: 'Prüfung bestanden',
  check_failed: 'Prüfung nicht bestanden',
  interrupted: 'Versuch unterbrochen',
};

const ENVIRONMENT_LABELS: Record<TrainingEnvironment, string> = {
  development: 'Entwicklungsumgebung',
  staging: 'Staging-Umgebung',
  demo: 'Demo-Umgebung',
  production: 'Produktivumgebung',
};

export function environmentLabel(environment: string | undefined): string {
  return environment !== undefined && environment in ENVIRONMENT_LABELS
    ? ENVIRONMENT_LABELS[environment as TrainingEnvironment]
    : 'dieser Umgebung';
}

export function attemptStatusLabel(status: string): string {
  return status in ATTEMPT_STATUS_LABELS
    ? ATTEMPT_STATUS_LABELS[status as TrainingAttemptStatus]
    : 'unbekannt';
}

export function exerciseStateLabel(state: string): string {
  return state in EXERCISE_STATE_LABELS
    ? EXERCISE_STATE_LABELS[state as TrainingExerciseState]
    : 'offen';
}

export function assignmentStatusLabel(status: string): string {
  return status in ASSIGNMENT_STATUS_LABELS
    ? ASSIGNMENT_STATUS_LABELS[status as TrainingAssignmentStatus]
    : 'zugewiesen';
}

export function clearanceSourceLabel(source: string): string {
  return source in CLEARANCE_SOURCE_LABELS
    ? CLEARANCE_SOURCE_LABELS[source as TrainingClearanceSource]
    : source === ''
      ? '–'
      : 'Freigabe';
}

export function eventResultLabel(result: string): string {
  return result in EVENT_RESULT_LABELS
    ? EVENT_RESULT_LABELS[result as TrainingEventResult]
    : 'Ereignis';
}

/** Unterbrechungsgrund in Du-Form für den betroffenen Mitarbeiter (§94, §48). */
export function interruptionText(code: string | null): string {
  switch (code) {
    case 'DEMO_DATA_RESET':
      return 'Dein Versuch wurde durch das Zurücksetzen der Demo-Daten unterbrochen – du kannst neu starten.';
    case 'TRAINING_RESET':
      return 'Dein Versuch wurde durch einen Training-Reset unterbrochen – du kannst neu starten.';
    default:
      return 'Dein Versuch wurde unterbrochen – du kannst neu starten.';
  }
}

/** Kurzform des Unterbrechungsgrunds für die Admin-Ansicht. */
export function interruptionLabel(code: string | null): string {
  switch (code) {
    case 'DEMO_DATA_RESET':
      return 'durch Demo-Reset unterbrochen';
    case 'TRAINING_RESET':
      return 'durch Training-Reset unterbrochen';
    case null:
      return '';
    default:
      return 'unterbrochen';
  }
}

/** Neutraler Fehlercode eines Trainingsereignisses als verständlicher Text (§54). */
export function trainingErrorLabel(code: string | null): string {
  switch (code) {
    case null:
      return '';
    case 'STEP_NOT_COMPLETED':
      return 'Schritt nicht abgeschlossen';
    case 'PREREQUISITE_MISSING':
      return 'Vorheriger Schritt noch nicht erledigt';
    default:
      return 'Schritt nicht erfüllt';
  }
}

/** Statusspalte der eigenen Live-Sperren (Design §4.6). */
export function gateStatusText(gate: GateStatusView, formatDate: (iso: string) => string): string {
  if (gate.configurationInvalid) return 'gesperrt (Sperre fehlerhaft konfiguriert)';
  if (!gate.cleared) return 'offen';
  if (gate.clearance === null) return 'freigegeben';
  if (gate.clearance.source === 'verified_demo') return 'freigegeben (Demo bestätigt)';
  return gate.clearance.validUntil !== null
    ? `freigegeben (Override bis ${formatDate(gate.clearance.validUntil)})`
    : 'freigegeben (Override)';
}

/** Zustand einer Freigabezeile – nie nur über Farbe (UX_RULES). */
export function clearanceStateLabel(clearance: ClearanceView, now: Date): string {
  if (clearance.revokedAt !== null) return 'widerrufen';
  if (clearance.validUntil !== null && new Date(clearance.validUntil).getTime() <= now.getTime()) {
    return 'abgelaufen';
  }
  return clearance.active ? 'aktiv' : 'inaktiv';
}

/** Anzeige „Nachname, Vorname“ einer Freigabe; unbekannter Mitarbeiter ⇒ neutraler Text. */
export function clearanceUserName(clearance: ClearanceView): string {
  return clearance.user === null
    ? 'Unbekannter Mitarbeiter'
    : `${clearance.user.lastName}, ${clearance.user.firstName}`;
}

export function clearanceTitle(clearance: ClearanceView): string {
  return clearance.definitionTitle ?? clearance.definitionKey;
}

/**
 * Link „Zum Demo-Bereich“ (§72): aufgelöste Seed-Entität vor dem sicheren
 * bekannten Pfad der Definition; nie eine beliebige Client-ID.
 */
export function demoLinkFor(definition: DefinitionView): string | null {
  const entity = definition.seedEntity;
  if (entity !== null) {
    switch (entity.entityType) {
      case 'process':
        return `/vorgaenge/${entity.entityId}`;
      case 'tour':
        return `/touren/${entity.entityId}`;
      case 'machine':
        return `/maschinen/${entity.entityId}`;
      default:
        break;
    }
  }
  return definition.demoPath;
}

export function fullName(user: { firstName: string; lastName: string }): string {
  return `${user.firstName} ${user.lastName}`.trim();
}
