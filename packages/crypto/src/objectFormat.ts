/**
 * The encrypted object container ("CVOBJ01").
 *
 * Everything the client uploads — message pages, attachments, manifests, the
 * optional original export — is written in this one format, so there is a single
 * code path to review and a single code path to restore.
 *
 * Layout
 * ------
 *   magic        8 bytes   "CVOBJ01\n"
 *   headerLen    2 bytes   big-endian
 *   header       JSON, non-secret: {v, cipher, objectId, kind, keySaltB64, frameSize}
 *   frame*       repeated:
 *                  4 bytes  big-endian ciphertext length
 *                  1 byte   flags (bit 0 = final frame)
 *                  n bytes  AES-256-GCM ciphertext, 16-byte tag included
 *
 * Properties this gives us (plan §6.3):
 *  - Streaming, bounded memory in both directions: one frame at a time.
 *  - Every frame is bound to its object, its position and its header, so frames
 *    cannot be reordered, swapped between objects, duplicated or dropped.
 *  - Truncation is detected: the stream is only valid if a frame marked `final`
 *    arrives and nothing follows it.
 *  - Nonce uniqueness is structural: each object derives a fresh key from a
 *    random 16-byte salt, and frame nonces are a counter under that key.
 */
import { IMPORT_LIMITS, OBJECT_FORMAT_VERSION, type ObjectKind } from '@chatvault/protocol';
import {
  canonicalJson,
  concat,
  fromBase64,
  fromUtf8,
  readUint32BE,
  readUint16BE,
  toBase64,
  toUtf8,
  writeUint16BE,
  writeUint32BE,
  writeUint64BE,
} from './bytes';
import {
  AES_GCM_TAG_BYTES,
  AuthenticationError,
  aesGcmDecrypt,
  aesGcmEncrypt,
  createStreamingSha256,
  hkdfSha256,
  importAesKey,
  nonceForFrame,
  randomBytes,
  sha256,
  type AesKey,
} from './primitives';
import { DEFAULT_FRAME_SIZE } from '@chatvault/protocol';

export const OBJECT_MAGIC = toUtf8('CVOBJ01\n');
const MAX_HEADER_BYTES = 1024;
const MAX_FRAME_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
const FRAME_FINAL = 0x01;
const KEY_SALT_BYTES = 16;

export interface ObjectHeader {
  v: number;
  cipher: 'A256GCM';
  objectId: string;
  kind: ObjectKind;
  keySaltB64: string;
  frameSize: number;
}

export interface ObjectStats {
  objectId: string;
  kind: ObjectKind;
  keySaltB64: string;
  frames: number;
  plaintextBytes: number;
  ciphertextBytes: number;
  /** Digest of the whole container, which the server re-checks on arrival. */
  ciphertextSha256: string;
  /** Digest of the plaintext, recorded in the manifest to detect rollbacks. */
  plaintextSha256: string;
}

/**
 * Per-object key.
 *
 * `material` is the vault subkey for this class of object; `keySalt` is random
 * per object. Even if an object identifier were ever reused, a different salt
 * yields a different key, so a (key, nonce) pair is never repeated.
 */
export async function deriveObjectKey(
  material: Uint8Array,
  objectId: string,
  keySalt: Uint8Array,
): Promise<AesKey> {
  const raw = await hkdfSha256(material, keySalt, toUtf8(`chatvault/object/v1/${objectId}`));
  return importAesKey(raw);
}

function buildHeaderBytes(header: ObjectHeader): Uint8Array {
  const json = toUtf8(canonicalJson(header));
  if (json.byteLength > MAX_HEADER_BYTES) throw new Error('Object header is too large');
  return concat([OBJECT_MAGIC, writeUint16BE(json.byteLength), json]);
}

function frameAad(headerDigest: Uint8Array, index: number, flags: number): Uint8Array {
  return concat([
    toUtf8('cvobj'),
    new Uint8Array([OBJECT_FORMAT_VERSION]),
    headerDigest,
    writeUint64BE(index),
    new Uint8Array([flags]),
  ]);
}

/** A simple FIFO of byte chunks, so we never concatenate the whole payload. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private length = 0;

  get size(): number {
    return this.length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
  }

  take(n: number): Uint8Array {
    if (n > this.length) throw new Error('ByteQueue underflow');
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      if (!head) throw new Error('ByteQueue underflow');
      const need = n - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled = n;
      }
    }
    this.length -= n;
    return out;
  }

  peek(n: number): Uint8Array | null {
    if (this.length < n) return null;
    let collected = 0;
    const parts: Uint8Array[] = [];
    for (const chunk of this.chunks) {
      const need = n - collected;
      if (chunk.byteLength >= need) {
        parts.push(chunk.subarray(0, need));
        collected = n;
        break;
      }
      parts.push(chunk);
      collected += chunk.byteLength;
    }
    return concat(parts);
  }
}

export interface ObjectWriterOptions {
  /** Vault subkey for this object class (`objects`, `manifests`, …). */
  material: Uint8Array;
  objectId: string;
  kind: ObjectKind;
  frameSize?: number;
}

/**
 * Streaming encryptor. Feed plaintext with `push`, collect the container bytes
 * it returns, and call `finish` exactly once.
 */
export class ObjectWriter {
  private readonly queue = new ByteQueue();
  private frameIndex = 0;
  private plaintextBytes = 0;
  private ciphertextBytes = 0;
  private headerEmitted = false;
  private finished = false;

  private constructor(
    private readonly key: AesKey,
    private readonly header: ObjectHeader,
    private readonly headerBytes: Uint8Array,
    private readonly headerDigest: Uint8Array,
    private readonly ciphertextHasher: Awaited<ReturnType<typeof createStreamingSha256>>,
    private readonly plaintextHasher: Awaited<ReturnType<typeof createStreamingSha256>>,
  ) {}

  static async create(options: ObjectWriterOptions): Promise<ObjectWriter> {
    const frameSize = options.frameSize ?? DEFAULT_FRAME_SIZE;
    if (frameSize < 1024 || frameSize > MAX_FRAME_CIPHERTEXT_BYTES - AES_GCM_TAG_BYTES - 1024) {
      throw new Error('frameSize is out of the supported range');
    }
    const keySalt = randomBytes(KEY_SALT_BYTES);
    const header: ObjectHeader = {
      v: OBJECT_FORMAT_VERSION,
      cipher: 'A256GCM',
      objectId: options.objectId,
      kind: options.kind,
      keySaltB64: toBase64(keySalt),
      frameSize,
    };
    const headerBytes = buildHeaderBytes(header);
    return new ObjectWriter(
      await deriveObjectKey(options.material, options.objectId, keySalt),
      header,
      headerBytes,
      await sha256(headerBytes),
      await createStreamingSha256(),
      await createStreamingSha256(),
    );
  }

  private emit(pieces: Uint8Array[], piece: Uint8Array): void {
    this.ciphertextHasher.update(piece);
    this.ciphertextBytes += piece.byteLength;
    pieces.push(piece);
  }

  private async sealFrame(pieces: Uint8Array[], plaintext: Uint8Array, final: boolean) {
    if (this.frameIndex >= IMPORT_LIMITS.maxFramesPerObject) {
      throw new Error('Object exceeds the maximum number of frames');
    }
    const flags = final ? FRAME_FINAL : 0;
    const ciphertext = await aesGcmEncrypt(
      this.key,
      nonceForFrame(this.frameIndex),
      plaintext,
      frameAad(this.headerDigest, this.frameIndex, flags),
    );
    this.emit(pieces, writeUint32BE(ciphertext.byteLength));
    this.emit(pieces, new Uint8Array([flags]));
    this.emit(pieces, ciphertext);
    this.frameIndex += 1;
  }

  /** Accepts plaintext and returns whatever container bytes are now ready. */
  async push(data: Uint8Array): Promise<Uint8Array[]> {
    if (this.finished) throw new Error('ObjectWriter is already finished');
    const pieces: Uint8Array[] = [];
    if (!this.headerEmitted) {
      this.headerEmitted = true;
      this.emit(pieces, this.headerBytes);
    }
    if (data.byteLength > 0) {
      this.plaintextBytes += data.byteLength;
      this.plaintextHasher.update(data);
      this.queue.push(data);
    }
    // Keep one full frame in hand so the final frame can be marked as final.
    while (this.queue.size > this.header.frameSize) {
      await this.sealFrame(pieces, this.queue.take(this.header.frameSize), false);
    }
    return pieces;
  }

  async finish(): Promise<{ pieces: Uint8Array[]; stats: ObjectStats }> {
    if (this.finished) throw new Error('ObjectWriter is already finished');
    const pieces = await this.push(new Uint8Array(0));
    this.finished = true;
    await this.sealFrame(pieces, this.queue.take(this.queue.size), true);
    return {
      pieces,
      stats: {
        objectId: this.header.objectId,
        kind: this.header.kind,
        keySaltB64: this.header.keySaltB64,
        frames: this.frameIndex,
        plaintextBytes: this.plaintextBytes,
        ciphertextBytes: this.ciphertextBytes,
        ciphertextSha256: this.ciphertextHasher.hex(),
        plaintextSha256: this.plaintextHasher.hex(),
      },
    };
  }
}

/** Reads the non-secret header. Needs no key; used by restore tooling. */
export function readObjectHeader(bytes: Uint8Array): ObjectHeader {
  if (bytes.byteLength < OBJECT_MAGIC.byteLength + 2) throw new Error('Not a ChatVault object');
  for (let i = 0; i < OBJECT_MAGIC.byteLength; i += 1) {
    if (bytes[i] !== OBJECT_MAGIC[i]) throw new Error('Not a ChatVault object');
  }
  const headerLen = readUint16BE(bytes, OBJECT_MAGIC.byteLength);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) throw new Error('Malformed object header');
  const start = OBJECT_MAGIC.byteLength + 2;
  const json = bytes.subarray(start, start + headerLen);
  if (json.byteLength !== headerLen) throw new Error('Truncated object header');
  const header = JSON.parse(fromUtf8(json)) as ObjectHeader;
  if (header.v !== OBJECT_FORMAT_VERSION) {
    throw new Error(`Unsupported object format version ${String(header.v)}`);
  }
  if (header.cipher !== 'A256GCM') throw new Error('Unsupported cipher');
  return header;
}

export interface ObjectReaderOptions {
  material: Uint8Array;
  /** Rejects an object the server may have substituted for the one we asked for. */
  expectedObjectId?: string;
}

/** Streaming decryptor; the mirror image of `ObjectWriter`. */
export class ObjectReader {
  private readonly queue = new ByteQueue();
  private header: ObjectHeader | null = null;
  private headerDigest: Uint8Array | null = null;
  private key: AesKey | null = null;
  private frameIndex = 0;
  private sawFinal = false;
  private plaintextBytes = 0;

  constructor(private readonly options: ObjectReaderOptions) {}

  get objectHeader(): ObjectHeader {
    if (!this.header) throw new Error('Object header has not been read yet');
    return this.header;
  }

  private async readHeader(): Promise<boolean> {
    const prefix = this.queue.peek(OBJECT_MAGIC.byteLength + 2);
    if (!prefix) return false;
    for (let i = 0; i < OBJECT_MAGIC.byteLength; i += 1) {
      if (prefix[i] !== OBJECT_MAGIC[i]) throw new Error('Not a ChatVault object');
    }
    const headerLen = readUint16BE(prefix, OBJECT_MAGIC.byteLength);
    if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) throw new Error('Malformed object header');
    const total = OBJECT_MAGIC.byteLength + 2 + headerLen;
    const full = this.queue.peek(total);
    if (!full) return false;
    this.queue.take(total);
    const header = readObjectHeader(full);
    if (this.options.expectedObjectId && header.objectId !== this.options.expectedObjectId) {
      throw new AuthenticationError('Object identifier does not match the one requested');
    }
    this.header = header;
    this.headerDigest = await sha256(full);
    this.key = await deriveObjectKey(
      this.options.material,
      header.objectId,
      fromBase64(header.keySaltB64),
    );
    return true;
  }

  /** Accepts container bytes and returns whatever plaintext is now available. */
  async push(bytes: Uint8Array): Promise<Uint8Array[]> {
    this.queue.push(bytes);
    const out: Uint8Array[] = [];
    if (!this.header && !(await this.readHeader())) return out;
    const header = this.header as ObjectHeader;
    const digest = this.headerDigest as Uint8Array;
    const key = this.key as AesKey;

    for (;;) {
      const prefix = this.queue.peek(5);
      if (!prefix) break;
      if (this.sawFinal) throw new AuthenticationError('Data found after the final frame');
      const length = readUint32BE(prefix, 0);
      const flags = prefix[4] as number;
      if (length < AES_GCM_TAG_BYTES || length > MAX_FRAME_CIPHERTEXT_BYTES) {
        throw new AuthenticationError('Frame length is out of range');
      }
      if (length > header.frameSize + AES_GCM_TAG_BYTES) {
        throw new AuthenticationError('Frame is larger than the header allows');
      }
      if ((flags & ~FRAME_FINAL) !== 0) throw new AuthenticationError('Unknown frame flags');
      const framed = this.queue.peek(5 + length);
      if (!framed) break;
      this.queue.take(5 + length);
      const plaintext = await aesGcmDecrypt(
        key,
        nonceForFrame(this.frameIndex),
        framed.subarray(5),
        frameAad(digest, this.frameIndex, flags),
      );
      this.frameIndex += 1;
      this.plaintextBytes += plaintext.byteLength;
      if ((flags & FRAME_FINAL) !== 0) this.sawFinal = true;
      if (plaintext.byteLength > 0) out.push(plaintext);
    }
    return out;
  }

  /** Throws unless a well-formed, complete object was consumed. */
  finish(): { frames: number; plaintextBytes: number } {
    if (!this.header) throw new AuthenticationError('Object was empty');
    if (!this.sawFinal) {
      throw new AuthenticationError('Object is truncated: no final frame was present');
    }
    if (this.queue.size !== 0)
      throw new AuthenticationError('Trailing bytes after the final frame');
    return { frames: this.frameIndex, plaintextBytes: this.plaintextBytes };
  }
}

export interface EncryptObjectOptions extends ObjectWriterOptions {
  data: Uint8Array;
}

export async function encryptObject(
  options: EncryptObjectOptions,
): Promise<{ bytes: Uint8Array; stats: ObjectStats }> {
  const writer = await ObjectWriter.create(options);
  const first = await writer.push(options.data);
  const { pieces, stats } = await writer.finish();
  return { bytes: concat([...first, ...pieces]), stats };
}

export async function decryptObject(
  options: ObjectReaderOptions & { bytes: Uint8Array },
): Promise<Uint8Array> {
  const reader = new ObjectReader(options);
  const pieces = await reader.push(options.bytes);
  reader.finish();
  return concat(pieces);
}

/** Decrypt an object that arrives as a stream, without buffering the ciphertext. */
export async function* decryptObjectStream(
  options: ObjectReaderOptions & { source: AsyncIterable<Uint8Array> },
): AsyncGenerator<Uint8Array> {
  const reader = new ObjectReader(options);
  for await (const chunk of options.source) {
    for (const piece of await reader.push(chunk)) yield piece;
  }
  reader.finish();
}
