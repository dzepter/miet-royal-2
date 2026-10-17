/**
 * Datensatzformen des lokalen IndexedDB-Stores (Phase-8-Order §§5, 59, 71).
 *
 * Im Klartext liegen ausschließlich technische Index-/Schlüsselfelder (IDs,
 * Status, Zeitstempel, SHA-256-Hashes). Alle fachlichen Inhalte (Snapshots,
 * Dokument-Bytes, Mutationspayloads, Medien, Konflikttexte) sind als
 * `EncryptedBlob` mit datensatzspezifischer AAD abgelegt. Keine Klartext-
 * Indizes mit Kundenname/Telefon/Adresse; QR nur als Hash.
 */
import type {
  ContextKind,
  MediaPurpose,
  MutationSummary,
  OfflineEnvironment,
  OfflineMutationType,
} from './mutations.ts';

/** AES-256-GCM-Chiffrat (Base64url), Version 1. */
export interface EncryptedBlob {
  v: 1;
  iv: string;
  ct: string;
}

export type MutationStatus =
  'pending' | 'syncing' | 'synced' | 'conflict' | 'failed_retryable' | 'failed_permanent';

export type MediaStatus = 'pending' | 'uploaded';

/** Lokale Kopie der Lease-Metadaten (HMAC-gesichert über `WorkspaceRecord.leaseMac`). */
export interface LeaseRecord {
  leaseId: string;
  userId: string;
  environment: OfflineEnvironment;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  /** Serverseitig signierter Claim (JSON-Text), Ed25519-Signatur und Verifikationsschlüssel (Base64url). */
  claim: string;
  signature: string;
  verificationKey: string;
  /** Rechte-Snapshot (nur operative Keys) – lokal nur Darstellung. */
  permissions: string[];
  firstName: string;
  lastName: string;
}

/**
 * Ein Arbeitsbereich je Benutzer × Umgebung × Gerät. Enthält NIE Passwort,
 * Passwort-Hash oder TOTP-Secrets – nur den zweifach eingewickelten DEK
 * (Wrap A = PBKDF2-KEK aus dem Passwort, Wrap B = Lease-Secret).
 */
export interface WorkspaceRecord {
  key: 'workspace';
  userId: string;
  environment: OfflineEnvironment;
  deviceId: string;
  createdAt: string;
  /** PBKDF2-Salt (Base64url). */
  salt: string;
  kdfIterations: number;
  wrappedByPassword: EncryptedBlob | null;
  wrappedByLease: EncryptedBlob | null;
  lease: LeaseRecord | null;
  /** HMAC-SHA-256 (HKDF aus DEK) über den Lease-Datensatz – Manipulation ⇒ lease_tampered. */
  leaseMac: string | null;
  lastAuthorizedAt: string;
}

export interface PackageRecord {
  packageId: string;
  environment: OfflineEnvironment;
  createdAt: string;
  serverTime: string;
  horizonFrom: string;
  horizonTo: string;
  /** Nach diesem Zeitpunkt darf das Paket (ohne Pending-Bezug) bereinigt werden. */
  expiresAt: string;
  bookingIds: string[];
  machineIds: string[];
  /** Verschlüsselt: Bestände laut Sync, Rechte, sonstige Metadaten. */
  payload: EncryptedBlob;
}

export interface BookingRecord {
  bookingId: string;
  processId: string;
  /** Index byPackage – Bereinigung veralteter Snapshots beim Paket-Ingest. */
  packageId: string;
  /** Erster relevanter Berliner Kalendertag (nur Sortierung), sonst null. */
  relevantDay: string | null;
  updatedAt: string;
  /** Verschlüsselt: OfflineBookingSnapshot inkl. Kontaktdaten. */
  payload: EncryptedBlob;
}

export interface MachineRecord {
  machineId: string;
  /** Index byQrHash – SHA-256 des QR-Tokens, nie der Rohtoken. */
  qrHash: string;
  packageId: string;
  updatedAt: string;
  /** Verschlüsselt: OfflineMachineSnapshot. */
  payload: EncryptedBlob;
}

export interface DocumentRecord {
  documentId: string;
  /** Index byBooking. */
  bookingId: string;
  type: string;
  createdAt: string;
  sha256: string;
  byteSize: number;
  /** Verschlüsselt: Dokument-Bytes (PDF). */
  payload: EncryptedBlob;
}

export interface MutationRecord {
  clientMutationId: string;
  type: OfflineMutationType;
  contextKind: ContextKind;
  /** Index byContext (v2) – Reihenfolge und Pending-Erkennung je Vorgang/Maschine. */
  contextId: string;
  /** Index bySeq – monotone lokale Reihenfolge. */
  seq: number;
  /** Index byStatus. */
  status: MutationStatus;
  createdAt: string;
  updatedAt: string;
  /** Mutationen, die zuvor synchronisiert sein müssen (z. B. Medien vor Finalisierung). */
  dependsOn: string[];
  mediaIds: string[];
  /** JSON-Basisstand (MUTATION_BASE_SCHEMAS). */
  baseVersion: string | null;
  retryCount: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  /** Nur Vorgangsnummer/Aktion/technisches Detail – keine Kundendaten. */
  summary: MutationSummary;
  /** Verschlüsselt: fachliche Payload (MUTATION_PAYLOAD_SCHEMAS). */
  payload: EncryptedBlob;
}

export interface MediaRecord {
  mediaId: string;
  purpose: MediaPurpose;
  mimeType: string;
  byteSize: number;
  sha256: string;
  /** Index byStatus – pending Medien werden nie automatisch bereinigt. */
  status: MediaStatus;
  contextKind: ContextKind;
  contextId: string;
  createdAt: string;
  /** Verschlüsselt: Bild-/Signaturbytes. */
  payload: EncryptedBlob;
}

export interface ConflictRecord {
  clientMutationId: string;
  /** Neutraler Code (CONFLICT_CODES bzw. Ablehnungscode). */
  code: string;
  status: 'conflict' | 'rejected';
  processedAt: string;
  /** Verschlüsselt: { message, serverState } – Konflikttexte können Fachdaten enthalten. */
  payload: EncryptedBlob;
}

export interface ReceiptRecord {
  clientMutationId: string;
  status: 'applied' | 'conflict' | 'rejected';
  processedAt: string;
  /** Technische Referenzen des Servers (IDs), keine Fachdaten. */
  resultRef: Record<string, string> | null;
  code: string | null;
}

/** Technische Metadaten (z. B. letzter Paketabruf, Bereinigungszeitpunkt). */
export interface MetaRecord {
  key: string;
  value: string | number | boolean | null;
  updatedAt: string;
}
