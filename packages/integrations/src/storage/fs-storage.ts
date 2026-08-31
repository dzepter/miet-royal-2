import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  assertValidStorageKey,
  StorageObjectNotFoundError,
  type PutOptions,
  type StorageProvider,
} from './storage.ts';

/**
 * Lokale Storage-Implementierung für Entwicklung und Tests.
 * Nicht für Produktion gedacht – dort kommt ein S3-kompatibler Provider
 * mit demselben Interface zum Einsatz (spätere Phase).
 */
export class FilesystemStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertValidStorageKey(key);
    return join(this.root, key);
  }

  async put(key: string, data: Uint8Array, _options?: PutOptions): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Uint8Array> {
    const path = this.pathFor(key);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
  }
}
