import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesystemStorageProvider } from '../src/storage/fs-storage.ts';
import { InvalidStorageKeyError, StorageObjectNotFoundError } from '../src/storage/storage.ts';

describe('FilesystemStorageProvider', () => {
  let root: string;
  let storage: FilesystemStorageProvider;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mietroyal-storage-'));
    storage = new FilesystemStorageProvider(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('schreibt, liest, prüft und löscht Objekte', async () => {
    const data = new TextEncoder().encode('protokoll-inhalt');
    await storage.put('documents/2026/test.pdf', data);

    expect(await storage.exists('documents/2026/test.pdf')).toBe(true);
    expect(new TextDecoder().decode(await storage.get('documents/2026/test.pdf'))).toBe(
      'protokoll-inhalt',
    );

    await storage.delete('documents/2026/test.pdf');
    expect(await storage.exists('documents/2026/test.pdf')).toBe(false);
  });

  it('wirft StorageObjectNotFoundError für unbekannte Schlüssel', async () => {
    await expect(storage.get('gibt/es/nicht.bin')).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it('blockiert Pfad-Traversal und ungültige Schlüssel', async () => {
    const data = new Uint8Array([1]);
    await expect(storage.put('../ausbruch.txt', data)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    await expect(storage.put('a/../../ausbruch.txt', data)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    await expect(storage.put('/absolut.txt', data)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.put('', data)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.put('a b.txt', data)).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });
});
