/**
 * Verschlüsselnder Store über der IndexedDB (Phase-8-Order §§5, 12, 59, 71).
 *
 * Alle fachlichen Inhalte (Snapshots, Dokument-Bytes, Mutationspayloads,
 * Medien, Konflikttexte) liegen als `EncryptedBlob` mit datensatzspezifischer
 * AAD (`AAD.booking(id)` usw.) – ohne gesetzten DEK (`setKey`) wirft jeder
 * fachliche Zugriff `WorkspaceLockedError`. Im Klartext liegen nur technische
 * Index-/Schlüsselfelder (IDs, Status, Zeitstempel, SHA-256-Hashes).
 */
import { decryptBytes, decryptJson, encryptBytes, encryptJson } from './crypto.ts';
import type { OfflineDb, StoreName } from './db.ts';
import type {
  ContextKind,
  MediaPurpose,
  MutationSummary,
  OfflineMutationType,
} from './mutations.ts';
import type {
  BookingRecord,
  ConflictRecord,
  DocumentRecord,
  EncryptedBlob,
  MachineRecord,
  MediaRecord,
  MetaRecord,
  MutationRecord,
  MutationStatus,
  PackageRecord,
  ReceiptRecord,
  WorkspaceRecord,
} from './records.ts';

export class WorkspaceLockedError extends Error {
  constructor() {
    super('Der Offline-Arbeitsbereich ist gesperrt.');
    this.name = 'WorkspaceLockedError';
  }
}

/** Datensatzspezifische AAD – ein Chiffrat gehört zu genau einem Datensatz. */
export const AAD = {
  package: (packageId: string) => `package:${packageId}`,
  booking: (bookingId: string) => `booking:${bookingId}`,
  machine: (machineId: string) => `machine:${machineId}`,
  document: (documentId: string) => `document:${documentId}`,
  mutation: (clientMutationId: string) => `mutation:${clientMutationId}`,
  media: (mediaId: string) => `media:${mediaId}`,
  conflict: (clientMutationId: string) => `conflict:${clientMutationId}`,
} as const;

export const MUTATION_STATUSES: readonly MutationStatus[] = [
  'pending',
  'syncing',
  'synced',
  'conflict',
  'failed_retryable',
  'failed_permanent',
];

const META_MUTATION_SEQ = 'mutationSeq';

/** Fachliche Stores – alles außer dem Workspace-Datensatz (Schlüssel-Wraps). */
const DATA_STORES: readonly StoreName[] = [
  'packages',
  'bookings',
  'machines',
  'documents',
  'mutations',
  'media',
  'conflicts',
  'receipts',
  'meta',
];

export type Decrypted<R extends { payload: unknown }, T> = Omit<R, 'payload'> & { payload: T };
export type DecryptedMutation = Decrypted<MutationRecord, unknown>;

export interface NewMutationInput {
  clientMutationId: string;
  type: OfflineMutationType;
  contextKind: ContextKind;
  contextId: string;
  payload: unknown;
  summary: MutationSummary;
  createdAt: string;
  dependsOn: string[];
  mediaIds?: string[];
  baseVersion?: string | null;
}

export interface NewMediaInput {
  mediaId: string;
  purpose: MediaPurpose;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
  contextKind: ContextKind;
  contextId: string;
  createdAt: string;
}

export interface ConflictInput {
  code: string;
  status: 'conflict' | 'rejected';
  message: string | null;
  serverState: unknown;
  processedAt: string;
}

export interface ConflictPayload {
  message: string | null;
  serverState: unknown;
}

export type MutationPatch = Partial<
  Pick<MutationRecord, 'status' | 'retryCount' | 'nextAttemptAt' | 'lastErrorCode' | 'baseVersion'>
>;

function bySeq(a: { seq: number }, b: { seq: number }): number {
  return a.seq - b.seq;
}

export class OfflineStore {
  private dek: CryptoKey | null = null;

  constructor(readonly db: OfflineDb) {}

  /** DEK setzen (nach Entsperrung) bzw. entfernen (Sperre). */
  setKey(key: CryptoKey | null): void {
    this.dek = key;
  }

  get hasKey(): boolean {
    return this.dek !== null;
  }

  private key(): CryptoKey {
    if (this.dek === null) throw new WorkspaceLockedError();
    return this.dek;
  }

  // ── Workspace (Klartext: nur eingewickelte Schlüssel + Lease-Metadaten) ──

  putWorkspace(record: WorkspaceRecord): Promise<void> {
    return this.db.put<WorkspaceRecord>('workspace', { ...record, key: 'workspace' });
  }

  getWorkspace(): Promise<WorkspaceRecord | undefined> {
    return this.db.get<WorkspaceRecord>('workspace', 'workspace');
  }

  deleteWorkspace(): Promise<void> {
    return this.db.delete('workspace', 'workspace');
  }

  // ── Meta ─────────────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<MetaRecord['value'] | undefined> {
    return (await this.db.get<MetaRecord>('meta', key))?.value;
  }

  setMeta(key: string, value: MetaRecord['value'], now: string): Promise<void> {
    return this.db.put<MetaRecord>('meta', { key, value, updatedAt: now });
  }

  // ── Pakete ───────────────────────────────────────────────────────────────

  async putPackage<T>(record: Omit<PackageRecord, 'payload'>, payload: T): Promise<void> {
    await this.db.put<PackageRecord>('packages', {
      ...record,
      payload: await encryptJson(this.key(), payload, AAD.package(record.packageId)),
    });
  }

  async getPackage<T>(packageId: string): Promise<Decrypted<PackageRecord, T> | null> {
    this.key();
    const record = await this.db.get<PackageRecord>('packages', packageId);
    if (record === undefined) return null;
    return this.decryptRecord<PackageRecord, T>(record, AAD.package(packageId));
  }

  listPackageRecords(): Promise<PackageRecord[]> {
    return this.db.getAll<PackageRecord>('packages');
  }

  async listPackages<T>(): Promise<Decrypted<PackageRecord, T>[]> {
    this.key();
    const result: Decrypted<PackageRecord, T>[] = [];
    for (const record of await this.listPackageRecords()) {
      const decrypted = await this.decryptRecord<PackageRecord, T>(
        record,
        AAD.package(record.packageId),
      );
      if (decrypted !== null) result.push(decrypted);
    }
    return result;
  }

  deletePackages(packageIds: readonly string[]): Promise<void> {
    return this.db.deleteMany('packages', packageIds);
  }

  // ── Vorgänge (Snapshots) ─────────────────────────────────────────────────

  putBooking<T>(record: Omit<BookingRecord, 'payload'>, payload: T): Promise<void> {
    return this.putBookings([{ record, payload }]);
  }

  async putBookings<T>(
    entries: readonly { record: Omit<BookingRecord, 'payload'>; payload: T }[],
  ): Promise<void> {
    const encrypted: BookingRecord[] = [];
    for (const entry of entries) {
      encrypted.push({
        ...entry.record,
        payload: await encryptJson(this.key(), entry.payload, AAD.booking(entry.record.bookingId)),
      });
    }
    await this.db.putMany('bookings', encrypted);
  }

  async getBooking<T>(bookingId: string): Promise<Decrypted<BookingRecord, T> | null> {
    this.key();
    const record = await this.db.get<BookingRecord>('bookings', bookingId);
    if (record === undefined) return null;
    return this.decryptRecord<BookingRecord, T>(record, AAD.booking(bookingId));
  }

  listBookingRecords(): Promise<BookingRecord[]> {
    return this.db.getAll<BookingRecord>('bookings');
  }

  listBookingRecordsByPackage(packageId: string): Promise<BookingRecord[]> {
    return this.db.getAllByIndex<BookingRecord>('bookings', 'byPackage', packageId);
  }

  async listBookings<T>(): Promise<Decrypted<BookingRecord, T>[]> {
    this.key();
    const result: Decrypted<BookingRecord, T>[] = [];
    for (const record of await this.listBookingRecords()) {
      const decrypted = await this.decryptRecord<BookingRecord, T>(
        record,
        AAD.booking(record.bookingId),
      );
      if (decrypted !== null) result.push(decrypted);
    }
    return result;
  }

  deleteBookings(bookingIds: readonly string[]): Promise<void> {
    return this.db.deleteMany('bookings', bookingIds);
  }

  // ── Maschinen (QR nur als Hash) ──────────────────────────────────────────

  async putMachines<T>(
    entries: readonly { record: Omit<MachineRecord, 'payload'>; payload: T }[],
  ): Promise<void> {
    const encrypted: MachineRecord[] = [];
    for (const entry of entries) {
      encrypted.push({
        ...entry.record,
        payload: await encryptJson(this.key(), entry.payload, AAD.machine(entry.record.machineId)),
      });
    }
    await this.db.putMany('machines', encrypted);
  }

  async getMachine<T>(machineId: string): Promise<Decrypted<MachineRecord, T> | null> {
    this.key();
    const record = await this.db.get<MachineRecord>('machines', machineId);
    if (record === undefined) return null;
    return this.decryptRecord<MachineRecord, T>(record, AAD.machine(machineId));
  }

  listMachineRecords(): Promise<MachineRecord[]> {
    return this.db.getAll<MachineRecord>('machines');
  }

  async listMachines<T>(): Promise<Decrypted<MachineRecord, T>[]> {
    this.key();
    const result: Decrypted<MachineRecord, T>[] = [];
    for (const record of await this.listMachineRecords()) {
      const decrypted = await this.decryptRecord<MachineRecord, T>(
        record,
        AAD.machine(record.machineId),
      );
      if (decrypted !== null) result.push(decrypted);
    }
    return result;
  }

  deleteMachines(machineIds: readonly string[]): Promise<void> {
    return this.db.deleteMany('machines', machineIds);
  }

  /** QR-Auflösung offline: ausschließlich über den SHA-256-Hash des Tokens (§13/§28). */
  async findMachineByQrHash<T>(qrHash: string): Promise<Decrypted<MachineRecord, T> | null> {
    this.key();
    const [record] = await this.db.getAllByIndex<MachineRecord>('machines', 'byQrHash', qrHash);
    if (record === undefined) return null;
    return this.decryptRecord<MachineRecord, T>(record, AAD.machine(record.machineId));
  }

  // ── Dokumente (PDF-Bytes verschlüsselt) ──────────────────────────────────

  async putDocument(record: Omit<DocumentRecord, 'payload'>, bytes: Uint8Array): Promise<void> {
    await this.db.put<DocumentRecord>('documents', {
      ...record,
      payload: await encryptBytes(this.key(), bytes, AAD.document(record.documentId)),
    });
  }

  async hasDocument(documentId: string): Promise<boolean> {
    return (await this.db.get<DocumentRecord>('documents', documentId)) !== undefined;
  }

  async getDocumentBytes(
    documentId: string,
  ): Promise<{ record: Omit<DocumentRecord, 'payload'>; bytes: Uint8Array } | null> {
    this.key();
    const record = await this.db.get<DocumentRecord>('documents', documentId);
    if (record === undefined) return null;
    const bytes = await decryptBytes(this.key(), record.payload, AAD.document(documentId));
    if (bytes === null) return null;
    const { payload: _encrypted, ...rest } = record;
    return { record: rest, bytes };
  }

  async listDocumentRecords(bookingId?: string): Promise<Omit<DocumentRecord, 'payload'>[]> {
    const records =
      bookingId === undefined
        ? await this.db.getAll<DocumentRecord>('documents')
        : await this.db.getAllByIndex<DocumentRecord>('documents', 'byBooking', bookingId);
    return records.map(({ payload: _encrypted, ...rest }) => rest);
  }

  deleteDocuments(documentIds: readonly string[]): Promise<void> {
    return this.db.deleteMany('documents', documentIds);
  }

  // ── Mutations-Queue ──────────────────────────────────────────────────────

  /** Nächste lokale Sequenznummer (monoton, über den Meta-Zähler). */
  private async nextSeq(now: string): Promise<number> {
    const current = await this.getMeta(META_MUTATION_SEQ);
    const seq = (typeof current === 'number' ? current : 0) + 1;
    await this.setMeta(META_MUTATION_SEQ, seq, now);
    return seq;
  }

  async enqueueMutation(input: NewMutationInput): Promise<MutationRecord> {
    const key = this.key();
    const seq = await this.nextSeq(input.createdAt);
    const record: MutationRecord = {
      clientMutationId: input.clientMutationId,
      type: input.type,
      contextKind: input.contextKind,
      contextId: input.contextId,
      seq,
      status: 'pending',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      dependsOn: [...input.dependsOn],
      mediaIds: [...(input.mediaIds ?? [])],
      baseVersion: input.baseVersion ?? null,
      retryCount: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      summary: input.summary,
      payload: await encryptJson(key, input.payload, AAD.mutation(input.clientMutationId)),
    };
    await this.db.put('mutations', record);
    return record;
  }

  getMutationRecord(clientMutationId: string): Promise<MutationRecord | undefined> {
    return this.db.get<MutationRecord>('mutations', clientMutationId);
  }

  async getMutation(clientMutationId: string): Promise<DecryptedMutation | null> {
    this.key();
    const record = await this.getMutationRecord(clientMutationId);
    if (record === undefined) return null;
    return this.decryptRecord<MutationRecord, unknown>(record, AAD.mutation(clientMutationId));
  }

  /** Klartext-Datensätze (ohne Payload-Entschlüsselung), nach Sequenz sortiert. */
  async listMutationRecords(): Promise<MutationRecord[]> {
    const records = await this.db.getAll<MutationRecord>('mutations');
    return records.sort(bySeq);
  }

  async listMutations(): Promise<DecryptedMutation[]> {
    this.key();
    const result: DecryptedMutation[] = [];
    for (const record of await this.listMutationRecords()) {
      const decrypted = await this.decryptRecord<MutationRecord, unknown>(
        record,
        AAD.mutation(record.clientMutationId),
      );
      if (decrypted !== null) result.push(decrypted);
    }
    return result;
  }

  async listMutationRecordsForContext(
    contextKind: ContextKind,
    contextId: string,
  ): Promise<MutationRecord[]> {
    const records = await this.db.getAllByIndex<MutationRecord>('mutations', 'byContext', [
      contextKind,
      contextId,
    ]);
    return records.sort(bySeq);
  }

  async listMutationsForContext(
    contextKind: ContextKind,
    contextId: string,
  ): Promise<DecryptedMutation[]> {
    this.key();
    const result: DecryptedMutation[] = [];
    for (const record of await this.listMutationRecordsForContext(contextKind, contextId)) {
      const decrypted = await this.decryptRecord<MutationRecord, unknown>(
        record,
        AAD.mutation(record.clientMutationId),
      );
      if (decrypted !== null) result.push(decrypted);
    }
    return result;
  }

  async updateMutation(
    clientMutationId: string,
    patch: MutationPatch,
    now: string,
  ): Promise<MutationRecord | null> {
    const row = await this.db.get<MutationRecord>('mutations', clientMutationId);
    if (row === undefined) return null;
    const updated: MutationRecord = { ...row, ...patch, updatedAt: now };
    await this.db.put('mutations', updated);
    return updated;
  }

  deleteMutations(clientMutationIds: readonly string[]): Promise<void> {
    return this.db.deleteMany('mutations', clientMutationIds);
  }

  async countByStatus(): Promise<Record<MutationStatus, number>> {
    const counts: Record<MutationStatus, number> = {
      pending: 0,
      syncing: 0,
      synced: 0,
      conflict: 0,
      failed_retryable: 0,
      failed_permanent: 0,
    };
    for (const record of await this.db.getAll<MutationRecord>('mutations')) {
      counts[record.status] += 1;
    }
    return counts;
  }

  // ── Medien (Fotos/Unterschriften) ────────────────────────────────────────

  async putMedia(input: NewMediaInput): Promise<MediaRecord> {
    const record: MediaRecord = {
      mediaId: input.mediaId,
      purpose: input.purpose,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      sha256: input.sha256,
      status: 'pending',
      contextKind: input.contextKind,
      contextId: input.contextId,
      createdAt: input.createdAt,
      payload: await encryptBytes(this.key(), input.bytes, AAD.media(input.mediaId)),
    };
    await this.db.put('media', record);
    return record;
  }

  async getMediaBytes(
    mediaId: string,
  ): Promise<{ record: Omit<MediaRecord, 'payload'>; bytes: Uint8Array } | null> {
    this.key();
    const record = await this.db.get<MediaRecord>('media', mediaId);
    if (record === undefined) return null;
    const bytes = await decryptBytes(this.key(), record.payload, AAD.media(mediaId));
    if (bytes === null) return null;
    const { payload: _encrypted, ...rest } = record;
    return { record: rest, bytes };
  }

  async updateMedia(
    mediaId: string,
    patch: Partial<Pick<MediaRecord, 'status'>>,
  ): Promise<MediaRecord | null> {
    const row = await this.db.get<MediaRecord>('media', mediaId);
    if (row === undefined) return null;
    const updated: MediaRecord = { ...row, ...patch };
    await this.db.put('media', updated);
    return updated;
  }

  deleteMedia(mediaIds: readonly string[]): Promise<void> {
    return this.db.deleteMany('media', mediaIds);
  }

  async listMediaRecords(): Promise<Omit<MediaRecord, 'payload'>[]> {
    const records = await this.db.getAll<MediaRecord>('media');
    return records.map(({ payload: _encrypted, ...rest }) => rest);
  }

  // ── Konflikte / Receipts ─────────────────────────────────────────────────

  async putConflict(clientMutationId: string, input: ConflictInput): Promise<void> {
    const payload: ConflictPayload = { message: input.message, serverState: input.serverState };
    await this.db.put<ConflictRecord>('conflicts', {
      clientMutationId,
      code: input.code,
      status: input.status,
      processedAt: input.processedAt,
      payload: await encryptJson(this.key(), payload, AAD.conflict(clientMutationId)),
    });
  }

  async getConflict<T = ConflictPayload>(
    clientMutationId: string,
  ): Promise<Decrypted<ConflictRecord, T> | null> {
    this.key();
    const record = await this.db.get<ConflictRecord>('conflicts', clientMutationId);
    if (record === undefined) return null;
    return this.decryptRecord<ConflictRecord, T>(record, AAD.conflict(clientMutationId));
  }

  async listConflictRecords(): Promise<Omit<ConflictRecord, 'payload'>[]> {
    const records = await this.db.getAll<ConflictRecord>('conflicts');
    return records.map(({ payload: _encrypted, ...rest }) => rest);
  }

  deleteConflict(clientMutationId: string): Promise<void> {
    return this.db.delete('conflicts', clientMutationId);
  }

  putReceipt(record: ReceiptRecord): Promise<void> {
    return this.db.put<ReceiptRecord>('receipts', record);
  }

  getReceipt(clientMutationId: string): Promise<ReceiptRecord | undefined> {
    return this.db.get<ReceiptRecord>('receipts', clientMutationId);
  }

  listReceipts(): Promise<ReceiptRecord[]> {
    return this.db.getAll<ReceiptRecord>('receipts');
  }

  deleteReceipts(clientMutationIds: readonly string[]): Promise<void> {
    return this.db.deleteMany('receipts', clientMutationIds);
  }

  // ── Bereinigung ──────────────────────────────────────────────────────────

  /** Alle fachlichen Daten entfernen (Logout ohne Pending, §38) – Workspace-Datensatz bleibt. */
  wipeData(): Promise<void> {
    return this.db.clearAll(DATA_STORES);
  }

  /** Alles entfernen – einschließlich der eingewickelten Schlüssel. */
  async wipeAll(): Promise<void> {
    await this.db.clearAll();
  }

  // ── intern ───────────────────────────────────────────────────────────────

  private async decryptRecord<R extends { payload: EncryptedBlob }, T>(
    record: R,
    aad: string,
  ): Promise<Decrypted<R, T> | null> {
    const payload = await decryptJson<T>(this.key(), record.payload, aad);
    if (payload === null) return null;
    const { payload: _encrypted, ...rest } = record;
    return { ...rest, payload } as Decrypted<R, T>;
  }
}
