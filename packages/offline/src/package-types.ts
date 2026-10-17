/**
 * Wire-Typen des Offline-Arbeitspakets, der Lease und des Statusendpunkts
 * (Phase-8-Order §§8–12, 78). DOM-frei; von API (Erzeuger) und Staff-PWA
 * (Verbraucher) gemeinsam genutzt. Die generischen Parameter `H`/`R` tragen
 * die bestehenden Übergabe-/Rückgabe-Detailsichten der Phasen 6/7.
 *
 * Datenminimierung (§11): nur operative Kontaktdaten (Name, Telefon,
 * Lieferadresse nur bei Lieferung), keine E-Mail-, Admin- oder Finanzdaten.
 */
import type { OfflineEnvironment } from './mutations.ts';

/** Grund, warum ein Vorgang im Paket liegt (Horizont heute ±3 Tage, aktiv, überfällig, bewusst geöffnet). */
export type OfflineBookingRelevance = 'handover' | 'return' | 'extra' | 'active' | 'overdue';

/** Markierung eines bestehenden Schadens am Maschinenschema (normalisiert 0..1). */
export interface OfflineDamageMarker {
  view: 'front' | 'back' | 'left' | 'right';
  markerType: 'point' | 'area';
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

/** Bestehender (aktueller) Schaden einer Maschine: Schema + Text, keine Fotos (Order §35). */
export interface OfflineExistingDamage {
  id: string;
  productSlug: string;
  severity: 'light' | 'medium' | 'severe';
  severityLabel: string;
  description: string;
  createdAt: string;
  markers: OfflineDamageMarker[];
  summary: string;
}

/** Serverseitig berechnete Problemlage einer Kandidaten-Maschine (Order §45/§49). */
export interface OfflineMachineProblem {
  code: string;
  /** Stabiler Deskriptor für Fingerprint-/Override-Abgleich. */
  descriptor: string;
  label: string;
  detail: string;
  /** Nur Hinweis, kein Override nötig. */
  warningOnly: boolean;
}

/** Offline wählbare Maschine für einen Slot – der Server rechnet die Lage beim Sync neu. */
export interface OfflineCandidateMachine {
  machineId: string;
  machineCode: string;
  situationFingerprint: string;
  overrideRequired: boolean;
  /** Physisch unmöglich (aktuell anderweitig ausgegeben) – nie wählbar. */
  hardBlocked: boolean;
  problems: OfflineMachineProblem[];
}

export interface OfflineAppointmentSnapshot {
  id: string;
  kind: string;
  /** Versionszähler des Termins – Basisstand für APPOINTMENT_CHANGED. */
  version: number;
  startAt: string | null;
  endAt: string | null;
  assignedUserId: string | null;
  /** Effektive Zuständigkeit inkl. Vertretung (Phase 2/4). */
  effectiveAssigneeId: string | null;
}

export interface OfflineDocumentReference {
  id: string;
  type: string;
  createdAt: string;
  sha256: string;
  byteSize: number;
}

/** Rückgabe-Saat: spiegelt, was `ReturnService.start` serverseitig anlegen würde. */
export interface OfflineReturnSeed {
  machines: { assignmentId: string; machineId: string }[];
  items: { deliveryNoteItemId: string; issuedQuantity: number; kind: string }[];
}

export interface OfflineBookingSnapshot<H = unknown, R = unknown> {
  bookingId: string;
  processId: string;
  processNumber: string;
  snapshotAt: string;
  /** Berliner Kalendertage (yyyy-mm-dd), an denen der Vorgang operativ relevant ist. */
  days: string[];
  relevance: OfflineBookingRelevance[];
  customer: {
    name: string;
    phone: string | null;
    /** Nur bei Lieferung befüllt, sonst leer. */
    deliveryAddressLines: string[];
  };
  appointments: OfflineAppointmentSnapshot[];
  /** Übergabe-Detailsicht (Phase 6) – null ohne handover.view. */
  handover: H | null;
  /** Rückgabe-Detailsicht (Phase 7) – null, wenn keine Rückgabe begonnen oder ohne return.view. */
  return: R | null;
  returnStartable: boolean;
  returnSeed: OfflineReturnSeed | null;
  /** Bestehende Schäden je Maschinen-ID der zugeordneten Maschinen. */
  existingDamages: Record<string, OfflineExistingDamage[]>;
  /** Kandidaten-Maschinen je Zuordnungs-ID (Slot). */
  candidateMachines: Record<string, OfflineCandidateMachine[]>;
  documents: OfflineDocumentReference[];
}

export interface OfflineMachineSnapshot {
  machineId: string;
  machineCode: string;
  /** SHA-256 des (kleingeschriebenen) QR-Tokens – der Rohtoken wird nie übertragen (§28). */
  qrHash: string;
  status: string;
  cleaningSince: string | null;
  /** Basisstand für machine.clean_complete (CLEANING_CYCLE_CHANGED). */
  updatedAt: string;
  machineTypeName: string | null;
  /** Maschinentyp für die Asset-Schnittstelle des Schadensschemas (Order §30). */
  productSlug: string | null;
  currentDamages: OfflineExistingDamage[];
}

/** Dokument mit Bytes (PDF) – lokal verschlüsselt abgelegt; sha256/byteSize zur Integritätsprüfung. */
export interface OfflineDocumentPayload extends OfflineDocumentReference {
  bookingId: string;
  dataBase64: string;
}

export interface OfflinePackage<H = unknown, R = unknown> {
  packageId: string;
  environment: OfflineEnvironment;
  serverTime: string;
  horizonFrom: string;
  horizonTo: string;
  /** Nach diesem Zeitpunkt gilt das Paket als veraltet (Bereinigung ohne Pending-Bezug). */
  expiresAt: string;
  /** Deckel (60 Vorgänge) erreicht – nicht alle relevanten Vorgänge enthalten. */
  truncated: boolean;
  user: { id: string; firstName: string; lastName: string };
  /** Rechte-Snapshot (nur operative Keys) – steuert lokal nur die Darstellung. */
  permissions: string[];
  lease: { leaseId: string; expiresAt: string };
  bookings: OfflineBookingSnapshot<H, R>[];
  machines: OfflineMachineSnapshot[];
  /** Bestände laut Sync (nur Anzeige, §23/§24) – null ohne inventory.view. */
  inventory: unknown[] | null;
  documents: OfflineDocumentPayload[];
}

/** Antwort von POST /staff/offline/lease (Ausstellung/Verlängerung; jede Verlängerung = neues Secret). */
export interface LeaseGrant {
  leaseId: string;
  userId: string;
  environment: OfflineEnvironment;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  /** Base64url – Wrap B des lokalen DEK; nur über die entsperrte Session abrufbar. */
  leaseSecret: string;
  permissions: string[];
  firstName: string;
  lastName: string;
}

/** Antwort des authentifizierten Health-Checks GET /staff/offline/status (verlängert die Aktivität NICHT). */
export interface OfflineStatusResponse {
  online: true;
  appLocked: boolean;
  serverTime: string;
  environment: OfflineEnvironment;
}
