import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertValidStorageKey,
  StorageObjectNotFoundError,
  type PutOptions,
  type StorageProvider,
} from './storage.ts';

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * S3-kompatibler PRIVATER Storage-Provider (Phase-3-Vorgabe Nr. 36):
 * - keine öffentlichen Objekte/ACLs – jeder Zugriff läuft über die
 *   autorisierte API oder eine kurzlebige signierte URL;
 * - getrennte Buckets/Secrets je Umgebung (assertConfigsIsolated);
 * - forcePathStyle für S3-kompatible Endpunkte (z. B. MinIO in Dev/Test).
 */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    assertValidStorageKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ...(options?.contentType === undefined ? {} : { ContentType: options.contentType }),
        // Bewusst KEINE ACL: der Bucket bleibt privat, Objekte erben das.
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    assertValidStorageKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = result.Body;
      if (body === undefined) throw new StorageObjectNotFoundError(key);
      return new Uint8Array(await body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey || error instanceof NotFound) {
        throw new StorageObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    assertValidStorageKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (
        error instanceof NotFound ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Kurzlebige signierte GET-URL (Default 5 Minuten) – niemals dauerhaft. */
  async signedGetUrl(key: string, expiresInSeconds = 300): Promise<string> {
    assertValidStorageKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
