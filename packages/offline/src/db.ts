/**
 * IndexedDB-Zugriff des Offline-Arbeitsbereichs (Phase-8-Order §§5, 71):
 * ein kleiner Promise-Wrapper ohne Framework-Bezug, ein explizit versioniertes
 * Schema mit Migrationsfunktionen (nie „löschen und neu anlegen“) und
 * Namespaces je Umgebung × Benutzer.
 *
 * Jede Schemaänderung ist eine neue Migration; Upgrades erhalten alle
 * Datensätze, ein Downgrade (ältere App gegen neuere Datenbank) bricht ab
 * (`VersionError`), statt Daten zu verwerfen.
 */
/** Aktuelle Schemaversion des lokalen Stores. Jede Änderung = neue Migration. */
export const OFFLINE_SCHEMA_VERSION = 2;

export type StoreName =
  | 'workspace'
  | 'packages'
  | 'bookings'
  | 'machines'
  | 'documents'
  | 'mutations'
  | 'media'
  | 'conflicts'
  | 'receipts'
  | 'meta';

export const STORE_NAMES: readonly StoreName[] = [
  'workspace',
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

export interface OfflineMigration {
  version: number;
  description: string;
  migrate(db: IDBDatabase, transaction: IDBTransaction): void;
}

export const OFFLINE_MIGRATIONS: readonly OfflineMigration[] = [
  {
    version: 1,
    description:
      'Grundschema: workspace, packages, bookings, machines, documents, mutations, media, conflicts, receipts, meta',
    migrate(db) {
      db.createObjectStore('workspace', { keyPath: 'key' });
      db.createObjectStore('packages', { keyPath: 'packageId' });
      const bookings = db.createObjectStore('bookings', { keyPath: 'bookingId' });
      bookings.createIndex('byPackage', 'packageId', { unique: false });
      const machines = db.createObjectStore('machines', { keyPath: 'machineId' });
      machines.createIndex('byQrHash', 'qrHash', { unique: false });
      const documents = db.createObjectStore('documents', { keyPath: 'documentId' });
      documents.createIndex('byBooking', 'bookingId', { unique: false });
      const mutations = db.createObjectStore('mutations', { keyPath: 'clientMutationId' });
      mutations.createIndex('bySeq', 'seq', { unique: true });
      mutations.createIndex('byStatus', 'status', { unique: false });
      const media = db.createObjectStore('media', { keyPath: 'mediaId' });
      media.createIndex('byStatus', 'status', { unique: false });
      db.createObjectStore('conflicts', { keyPath: 'clientMutationId' });
      db.createObjectStore('receipts', { keyPath: 'clientMutationId' });
      db.createObjectStore('meta', { keyPath: 'key' });
    },
  },
  {
    version: 2,
    description: 'Kontext-Index der Queue (Reihenfolge/Pending je Vorgang bzw. Maschine)',
    migrate(_db, transaction) {
      transaction
        .objectStore('mutations')
        .createIndex('byContext', ['contextKind', 'contextId'], { unique: false });
    },
  },
];

/** Datenbankname je Umgebung × Benutzer – Namespaces vermischen sich nie (§77, Test 115). */
export function offlineDbName(environment: string, userId: string): string {
  return `mietroyal-offline-${environment}-${userId}`;
}

function indexedDb(): IDBFactory {
  const factory = globalThis.indexedDB;
  if (factory === undefined) throw new Error('IndexedDB ist nicht verfügbar.');
  return factory;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB-Anfrage fehlgeschlagen.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB-Transaktion abgebrochen.'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB-Transaktion fehlgeschlagen.'));
  });
}

/**
 * Datenbank öffnen und Migrationen sequenziell anwenden (nur die Versionen
 * zwischen bisheriger und Zielversion). Ein Downgrade wird von IndexedDB
 * mit `VersionError` abgelehnt – wir reichen ihn unverändert weiter.
 */
export function openOfflineDatabase(
  name: string,
  targetVersion = OFFLINE_SCHEMA_VERSION,
  migrations: readonly OfflineMigration[] = OFFLINE_MIGRATIONS,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDb().open(name, targetVersion);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (transaction === null) {
        reject(new Error('IndexedDB-Upgrade ohne Transaktion.'));
        return;
      }
      const from = event.oldVersion;
      const applicable = [...migrations]
        .filter((m) => m.version > from && m.version <= targetVersion)
        .sort((a, b) => a.version - b.version);
      try {
        for (const migration of applicable) migration.migrate(db, transaction);
      } catch (error) {
        transaction.abort();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Ein anderer Tab möchte upgraden: eigene Verbindung freigeben, damit
      // die Migration nicht blockiert (Daten bleiben erhalten).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB konnte nicht geöffnet werden.'));
    request.onblocked = () => {
      // Andere Verbindungen blockieren das Upgrade; sie schließen sich über
      // `versionchange`, danach läuft die Anfrage weiter. Kein Fehler.
    };
  });
}

export function deleteOfflineDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDb().deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB konnte nicht gelöscht werden.'));
    request.onblocked = () => {
      // Wird fortgesetzt, sobald offene Verbindungen geschlossen sind.
    };
  });
}

/** Promise-Wrapper um eine geöffnete IndexedDB-Verbindung. */
export class OfflineDb {
  constructor(readonly raw: IDBDatabase) {}

  get version(): number {
    return this.raw.version;
  }

  get name(): string {
    return this.raw.name;
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const transaction = this.raw.transaction(store, 'readonly');
    const result = (await requestToPromise(transaction.objectStore(store).get(key))) as
      T | undefined;
    return result;
  }

  async put<T>(store: StoreName, value: T): Promise<void> {
    const transaction = this.raw.transaction(store, 'readwrite');
    transaction.objectStore(store).put(value);
    await transactionDone(transaction);
  }

  async putMany<T>(store: StoreName, values: readonly T[]): Promise<void> {
    if (values.length === 0) return;
    const transaction = this.raw.transaction(store, 'readwrite');
    const objectStore = transaction.objectStore(store);
    for (const value of values) objectStore.put(value);
    await transactionDone(transaction);
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    const transaction = this.raw.transaction(store, 'readonly');
    return (await requestToPromise(transaction.objectStore(store).getAll())) as T[];
  }

  async getAllByIndex<T>(
    store: StoreName,
    index: string,
    query: IDBValidKey | IDBKeyRange,
  ): Promise<T[]> {
    const transaction = this.raw.transaction(store, 'readonly');
    return (await requestToPromise(
      transaction.objectStore(store).index(index).getAll(query),
    )) as T[];
  }

  async getAllKeys(store: StoreName): Promise<IDBValidKey[]> {
    const transaction = this.raw.transaction(store, 'readonly');
    return requestToPromise(transaction.objectStore(store).getAllKeys());
  }

  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    const transaction = this.raw.transaction(store, 'readwrite');
    transaction.objectStore(store).delete(key);
    await transactionDone(transaction);
  }

  async deleteMany(store: StoreName, keys: readonly IDBValidKey[]): Promise<void> {
    if (keys.length === 0) return;
    const transaction = this.raw.transaction(store, 'readwrite');
    const objectStore = transaction.objectStore(store);
    for (const key of keys) objectStore.delete(key);
    await transactionDone(transaction);
  }

  async count(store: StoreName): Promise<number> {
    const transaction = this.raw.transaction(store, 'readonly');
    return requestToPromise(transaction.objectStore(store).count());
  }

  async clearAll(stores: readonly StoreName[] = STORE_NAMES): Promise<void> {
    if (stores.length === 0) return;
    const transaction = this.raw.transaction([...stores], 'readwrite');
    for (const store of stores) transaction.objectStore(store).clear();
    await transactionDone(transaction);
  }

  close(): void {
    this.raw.close();
  }
}
