/**
 * Wire-Typen des Offline-Arbeitspakets, der Lease und des Statusendpunkts
 * (Phase-8-Order §§8–12, 78). DOM-frei; von API (Erzeuger) und Staff-PWA
 * (Verbraucher) gemeinsam genutzt. Die generischen Parameter `H`/`R` tragen
 * die bestehenden Übergabe-/Rückgabe-Detailsichten der Phasen 6/7.
 *
 * Datenminimierung (§11): nur operative Kontaktdaten (Name, Telefon,
 * Lieferadresse nur bei Lieferung), keine E-Mail-, Admin- oder Finanzdaten.
 */
import { OFFLINE_ENVIRONMENTS, type OfflineEnvironment } from './mutations.ts';

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
  /**
   * Serverseitig signierter Lease-Claim (Phase-8-Finalisierung §1): exakt der
   * JSON-Text eines `OfflineLeaseClaim`, über dessen UTF-8-Bytes der Server mit
   * Ed25519 signiert hat. Der Client verifiziert die Signatur vollständig offline
   * und übernimmt userId/deviceId/environment/issuedAt/expiresAt NUR aus dem
   * verifizierten Claim – nie aus lokal veränderbaren Feldern.
   */
  claim: string;
  /** Base64url – Ed25519-Signatur über die UTF-8-Bytes von `claim`. */
  signature: string;
  /** Base64url – roher 32-Byte-Ed25519-Verifikationsschlüssel (nur öffentlich; Signatur bleibt serverseitig). */
  verificationKey: string;
  /** Base64url – Wrap B des lokalen DEK; nur über die entsperrte Session abrufbar. */
  leaseSecret: string;
  permissions: string[];
  firstName: string;
  lastName: string;
}

/** Inhalt des signierten Lease-Claims (Feldreihenfolge = Serialisierungsreihenfolge). */
export interface OfflineLeaseClaim {
  v: 1;
  leaseId: string;
  userId: string;
  deviceId: string;
  environment: OfflineEnvironment;
  issuedAt: string;
  expiresAt: string;
  /** Zufällige Nonce (Base64url, 16 Byte) – jede Ausstellung ist einzigartig. */
  nonce: string;
}

/** Maximale Lease-Laufzeit (Order §8): expiresAt ≤ issuedAt + 72 h – Server UND Client prüfen das. */
export const OFFLINE_LEASE_MAX_MS = 72 * 3_600_000;

/**
 * Claim-Text parsen und strukturell prüfen (keine Signaturprüfung – die läuft
 * in Server (node:crypto) bzw. Client (WebCrypto Ed25519)). Gibt null zurück,
 * wenn Struktur, Laufzeit (≤ 72 h) oder Zeitformat ungültig sind.
 */
export function parseOfflineLeaseClaim(claimText: string): OfflineLeaseClaim | null {
  let raw: unknown;
  try {
    raw = JSON.parse(claimText);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof c[k] === 'string' ? (c[k] as string) : null);
  const leaseId = str('leaseId');
  const userId = str('userId');
  const deviceId = str('deviceId');
  const environment = str('environment');
  const issuedAt = str('issuedAt');
  const expiresAt = str('expiresAt');
  const nonce = str('nonce');
  if (
    c['v'] !== 1 ||
    leaseId === null ||
    userId === null ||
    deviceId === null ||
    environment === null ||
    issuedAt === null ||
    expiresAt === null ||
    nonce === null ||
    !(OFFLINE_ENVIRONMENTS as readonly string[]).includes(environment)
  ) {
    return null;
  }
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return null;
  if (expires <= issued || expires - issued > OFFLINE_LEASE_MAX_MS) return null;
  return {
    v: 1,
    leaseId,
    userId,
    deviceId,
    environment: environment as OfflineEnvironment,
    issuedAt,
    expiresAt,
    nonce,
  };
}

/** Antwort des authentifizierten Health-Checks GET /staff/offline/status (verlängert die Aktivität NICHT). */
export interface OfflineStatusResponse {
  online: true;
  appLocked: boolean;
  serverTime: string;
  environment: OfflineEnvironment;
}
