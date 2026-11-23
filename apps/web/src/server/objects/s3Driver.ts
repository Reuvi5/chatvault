/**
 * S3-compatible object driver, used for Cloudflare R2 (primary) and
 * Backblaze B2 (secondary).
 *
 * Each provider gets its own driver instance with its own credentials, so a
 * leaked key for one copy cannot reach the other (plan §7).
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { ObjectStoreError, assertSafeKey, type ObjectDriver, type ObjectHead } from './driver';

export interface S3DriverOptions {
  label: string;
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  partSizeBytes: number;
}

export class S3ObjectDriver implements ObjectDriver {
  readonly kind = 's3' as const;
  readonly label: string;
  readonly partSizeBytes: number;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3DriverOptions) {
    this.label = options.label;
    this.bucket = options.bucket;
    // S3 multipart uploads require every part except the last to be >= 5 MiB.
    this.partSizeBytes = Math.max(5 * 1024 * 1024, options.partSizeBytes);
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  get location(): string {
    return `s3://${this.bucket}`;
  }

  private wrap(error: unknown, key: string): ObjectStoreError {
    const name = (error as { name?: string } | null)?.name ?? '';
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
      ?.httpStatusCode;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) {
      return new ObjectStoreError(`${key} is not in ${this.label}`, 'not_found', error);
    }
    return new ObjectStoreError(
      `${this.label} could not be reached for ${key}`,
      'unavailable',
      error,
    );
  }

  async beginUpload(key: string): Promise<{ uploadId: string | null }> {
    assertSafeKey(key);
    try {
      const result = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: 'application/octet-stream',
        }),
      );
      return { uploadId: result.UploadId ?? null };
    } catch (error) {
      throw this.wrap(error, key);
    }
  }

  async uploadPart(
    key: string,
    uploadId: string | null,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<{ etag: string | null }> {
    assertSafeKey(key);
    if (!uploadId) throw new ObjectStoreError('Missing multipart upload id', 'rejected');
    try {
      const result = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: bytes,
        }),
      );
      return { etag: result.ETag ?? null };
    } catch (error) {
      throw this.wrap(error, key);
    }
  }

  async completeUpload(
    key: string,
    uploadId: string | null,
    parts: Array<{ partNumber: number; etag: string | null }>,
  ): Promise<ObjectHead> {
    assertSafeKey(key);
    if (!uploadId) throw new ObjectStoreError('Missing multipart upload id', 'rejected');
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag ?? undefined })),
          },
        }),
      );
      const head = await this.head(key);
      if (!head) throw new ObjectStoreError(`${key} vanished after completion`, 'unavailable');
      return head;
    } catch (error) {
      throw this.wrap(error, key);
    }
  }

  async abortUpload(key: string, uploadId: string | null): Promise<void> {
    if (!uploadId) return;
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch {
      // Aborting is best effort; a lifecycle rule removes stale parts.
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<ObjectHead> {
    assertSafeKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/octet-stream',
        }),
      );
      return { bytes: bytes.byteLength };
    } catch (error) {
      throw this.wrap(error, key);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) throw new ObjectStoreError(`${key} returned no body`, 'unavailable');
      return new Uint8Array(bytes);
    } catch (error) {
      throw this.wrap(error, key);
    }
  }

  async getWebStream(key: string): Promise<ReadableStream<Uint8Array>> {
    assertSafeKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = result.Body as { transformToWebStream?: () => ReadableStream } | undefined;
      if (body?.transformToWebStream) {
        return body.transformToWebStream() as ReadableStream<Uint8Array>;
      }
      const bytes = await this.get(key);
      return new Blob([bytes as unknown as BlobPart]).stream() as ReadableStream<Uint8Array>;
    } catch (error) {
      throw this.wrap(error, key);
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertSafeKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { bytes: Number(result.ContentLength ?? 0), etag: result.ETag ?? null };
    } catch (error) {
      const wrapped = this.wrap(error, key);
      if (wrapped.code === 'not_found') return null;
      throw wrapped;
    }
  }

  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      const wrapped = this.wrap(error, key);
      if (wrapped.code !== 'not_found') throw wrapped;
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: `${this.label}: ${this.location}` };
    } catch (error) {
      return {
        ok: false,
        detail: `${this.label}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
