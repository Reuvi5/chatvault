/**
 * Object storage drivers.
 *
 * Two implementations behind one interface: a local filesystem driver for
 * development and the drill, and an S3-compatible driver that talks to
 * Cloudflare R2 (primary) and Backblaze B2 (secondary) with separate
 * credentials. The server moves ciphertext only, and provider credentials never
 * leave the server (plan §5, §7).
 */

export interface UploadPartResult {
  /** Entity tag, where the provider supplies one. */
  etag: string | null;
}

export interface ObjectHead {
  bytes: number;
  etag?: string | null;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

export interface ObjectDriver {
  readonly label: string;
  readonly kind: 'local' | 's3';
  /** Human-readable destination, recorded on each replica row. */
  readonly location: string;
  readonly partSizeBytes: number;

  beginUpload(key: string): Promise<{ uploadId: string | null }>;
  uploadPart(
    key: string,
    uploadId: string | null,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<UploadPartResult>;
  completeUpload(
    key: string,
    uploadId: string | null,
    parts: Array<{ partNumber: number; etag: string | null }>,
  ): Promise<ObjectHead>;
  abortUpload(key: string, uploadId: string | null): Promise<void>;

  put(key: string, bytes: Uint8Array): Promise<ObjectHead>;
  get(key: string): Promise<Uint8Array>;
  getWebStream(key: string): Promise<ReadableStream<Uint8Array>>;
  head(key: string): Promise<ObjectHead | null>;
  remove(key: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'unavailable' | 'rejected',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,512}$/u;

/** Storage keys are built from opaque identifiers only; verify that here too. */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) {
    throw new ObjectStoreError(`Refusing to use an unsafe storage key: ${key}`, 'rejected');
  }
}
