import type { StorageConfig } from '@mietroyal/config';
import { FilesystemStorageProvider } from './fs-storage.ts';
import { S3StorageProvider } from './s3-storage.ts';
import type { StorageProvider } from './storage.ts';

export function createStorageProvider(config: StorageConfig): StorageProvider {
  switch (config.driver) {
    case 'fs':
      return new FilesystemStorageProvider(config.fsRoot);
    case 's3':
      // Privater S3-kompatibler Storage (MinIO in Dev/Test, echtes S3 in
      // Production); getrennte Buckets/Secrets je Umgebung erzwingt
      // assertConfigsIsolated.
      return new S3StorageProvider({
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
  }
}
