/**
 * Privater Objektspeicher hinter einem Interface (ARCHITECTURE.md "Storage").
 * Phase 0: Filesystem-Implementierung für lokale Entwicklung.
 * Später: S3-kompatibler Provider mit identischem Interface – Aufrufer
 * bleiben unverändert. Öffentliche Buckets gibt es nicht; Zugriff läuft
 * immer über autorisierte Serverpfade.
 */

export interface PutOptions {
  contentType?: string;
}

export interface StorageProvider {
  put(key: string, data: Uint8Array, options?: PutOptions): Promise<void>;
  /** Wirft StorageObjectNotFoundError, wenn der Schlüssel nicht existiert. */
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage-Objekt nicht gefunden: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Ungültiger Storage-Key: ${key}`);
    this.name = 'InvalidStorageKeyError';
  }
}

const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/**
 * Erlaubt nur harmlose, S3-kompatible Schlüssel und verhindert
 * Pfad-Traversal (z. B. "../../etc/passwd") im Filesystem-Provider.
 */
export function assertValidStorageKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    !STORAGE_KEY_PATTERN.test(key) ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new InvalidStorageKeyError(key);
  }
}
