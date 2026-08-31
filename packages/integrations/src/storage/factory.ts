import type { StorageConfig } from '@mietroyal/config';
import { FilesystemStorageProvider } from './fs-storage.ts';
import type { StorageProvider } from './storage.ts';

export function createStorageProvider(config: StorageConfig): StorageProvider {
  switch (config.driver) {
    case 'fs':
      return new FilesystemStorageProvider(config.fsRoot);
    case 's3':
      // Die Konfiguration ist bereits vorgesehen (packages/config), damit
      // demo/staging/production strukturell getrennte Buckets nutzen können.
      throw new Error(
        'S3-Storage-Provider ist noch nicht implementiert (folgt mit dem ersten Datei-Feature).',
      );
  }
}
