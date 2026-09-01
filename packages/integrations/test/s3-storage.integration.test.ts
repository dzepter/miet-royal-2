/**
 * Phase-3-Pflichttests 55/56 gegen echtes MinIO (infra/docker-compose.yml):
 * S3-Provider-Roundtrip, KEIN öffentlicher Objektzugriff (anonym → 403),
 * kurzlebige signierte URLs und Bucket-Isolation zwischen Umgebungen.
 * Die Konfigurations-Seite der Isolation (gleicher Bucket/gleiche Secrets
 * → Startabbruch) ist in packages/config/test abgedeckt.
 *
 * Voraussetzung: `pnpm infra:up` (MinIO auf 127.0.0.1:59000).
 */
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { S3StorageProvider } from '../src/storage/s3-storage.ts';
import { StorageObjectNotFoundError } from '../src/storage/storage.ts';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000';
const CREDENTIALS = {
  accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? 'mietroyal-local',
  secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? 'mietroyal_local_dev_storage',
};
const BUCKET_A = 'mietroyal-test-storage-a';
const BUCKET_B = 'mietroyal-test-storage-b';

function providerFor(bucket: string): S3StorageProvider {
  return new S3StorageProvider({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    bucket,
    ...CREDENTIALS,
  });
}

beforeAll(async () => {
  const client = new S3Client({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: CREDENTIALS,
  });
  for (const bucket of [BUCKET_A, BUCKET_B]) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
    }
  }
  client.destroy();
});

describe('55. S3-Provider: privater Zugriff', () => {
  it('Roundtrip put → exists → get → delete funktioniert', async () => {
    const storage = providerFor(BUCKET_A);
    const key = `documents/test/${randomUUID()}.pdf`;
    const payload = new Uint8Array(Buffer.from('%PDF-1.7 test-roundtrip'));

    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, payload, { contentType: 'application/pdf' });
    expect(await storage.exists(key)).toBe(true);
    expect(Buffer.from(await storage.get(key)).equals(Buffer.from(payload))).toBe(true);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it('Anonymer HTTP-Zugriff auf ein Objekt wird abgewiesen (kein public read)', async () => {
    const storage = providerFor(BUCKET_A);
    const key = `documents/test/${randomUUID()}.pdf`;
    await storage.put(key, new Uint8Array(Buffer.from('privat')), {
      contentType: 'application/pdf',
    });
    try {
      const response = await fetch(`${ENDPOINT}/${BUCKET_A}/${key}`);
      expect(response.status).toBe(403);
    } finally {
      await storage.delete(key);
    }
  });

  it('Signierte GET-URL liefert das Objekt; manipulierte Signatur wird abgewiesen', async () => {
    const storage = providerFor(BUCKET_A);
    const key = `documents/test/${randomUUID()}.pdf`;
    const payload = Buffer.from('%PDF-1.7 signiert');
    await storage.put(key, new Uint8Array(payload), { contentType: 'application/pdf' });
    try {
      const url = await storage.signedGetUrl(key, 120);
      expect(url).toContain('X-Amz-Signature=');
      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).equals(payload)).toBe(true);

      const tampered = url.replace(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=deadbeef');
      const denied = await fetch(tampered);
      expect(denied.status).toBe(403);
    } finally {
      await storage.delete(key);
    }
  });
});

describe('56. Storage-Isolation zwischen Umgebungen', () => {
  it('Objekte eines Buckets sind im anderen Bucket nicht sichtbar', async () => {
    const storageA = providerFor(BUCKET_A);
    const storageB = providerFor(BUCKET_B);
    const key = `documents/test/${randomUUID()}.pdf`;
    await storageA.put(key, new Uint8Array(Buffer.from('nur-umgebung-a')));
    try {
      expect(await storageB.exists(key)).toBe(false);
      await expect(storageB.get(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
      expect(await storageA.exists(key)).toBe(true);
    } finally {
      await storageA.delete(key);
    }
  });
});
