/**
 * The only primitives this project uses, all from reviewed implementations:
 *  - AES-256-GCM, HKDF-SHA-256 and SHA-256 from the platform Web Crypto API
 *  - Argon2id from hash-wasm (a published, widely used WASM build)
 *
 * Nothing here implements a cipher, hash or KDF by hand (plan §5 "never custom
 * cryptographic primitives").
 */
import { argon2id, createSHA256 } from 'hash-wasm';
import { concat, toHex } from './bytes';

export const AES_GCM_TAG_BITS = 128;
export const AES_GCM_TAG_BYTES = 16;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) {
    throw new Error(
      'Web Crypto is unavailable. ChatVault needs a secure context (https or localhost) and Node 20+.',
    );
  }
  return webcrypto.subtle;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle().digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

/** Incremental SHA-256 for streams whose length is not known up front. */
export async function createStreamingSha256(): Promise<{
  update: (chunk: Uint8Array) => void;
  hex: () => string;
}> {
  const hasher = await createSHA256();
  hasher.init();
  let finished: string | null = null;
  return {
    update(chunk) {
      if (finished !== null) throw new Error('Hasher already finalized');
      hasher.update(chunk);
    },
    hex() {
      if (finished === null) finished = hasher.digest('hex');
      return finished;
    },
  };
}

export interface Argon2idParams {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/**
 * Interactive defaults: 64 MiB of memory is affordable on older phones while
 * still being expensive to attack in bulk (plan §6.3 item 2).
 */
export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = {
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

/** Reduced parameters, used only by the test suite and by local drills. */
export const FAST_ARGON2ID_PARAMS: Argon2idParams = {
  memoryKiB: 8 * 1024,
  iterations: 1,
  parallelism: 1,
};

export async function deriveArgon2id(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  if (salt.byteLength < 16) throw new Error('Argon2id salt must be at least 16 bytes');
  if (params.memoryKiB < 8 * 1024) throw new Error('Argon2id memory parameter is too low');
  if (params.iterations < 1) throw new Error('Argon2id iteration count must be at least 1');
  const hash = await argon2id({
    password: passphrase,
    salt,
    memorySize: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
  return new Uint8Array(hash);
}

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length = KEY_BYTES,
): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', ikm as unknown as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as unknown as BufferSource,
      info: info as unknown as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export type AesKey = CryptoKey;

export async function importAesKey(raw: Uint8Array): Promise<AesKey> {
  if (raw.byteLength !== KEY_BYTES) throw new Error('AES-256 keys must be 32 bytes');
  return subtle().importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function aesGcmEncrypt(
  key: AesKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.byteLength !== NONCE_BYTES) throw new Error('AES-GCM nonce must be 12 bytes');
  const out = await subtle().encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as unknown as BufferSource,
      additionalData: additionalData as unknown as BufferSource,
      tagLength: AES_GCM_TAG_BITS,
    },
    key,
    plaintext as unknown as BufferSource,
  );
  return new Uint8Array(out);
}

export class AuthenticationError extends Error {
  constructor(message = 'Decryption failed: the data was altered, truncated or the key is wrong') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export async function aesGcmDecrypt(
  key: AesKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.byteLength !== NONCE_BYTES) throw new Error('AES-GCM nonce must be 12 bytes');
  if (ciphertext.byteLength < AES_GCM_TAG_BYTES) throw new AuthenticationError();
  try {
    const out = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as unknown as BufferSource,
        additionalData: additionalData as unknown as BufferSource,
        tagLength: AES_GCM_TAG_BITS,
      },
      key,
      ciphertext as unknown as BufferSource,
    );
    return new Uint8Array(out);
  } catch {
    // Never leak which part failed.
    throw new AuthenticationError();
  }
}

/**
 * Frame nonce.
 *
 * Every object gets a fresh random key (see `deriveObjectKey`), so a plain
 * counter nonce is guaranteed unique for that key. The first four bytes are
 * reserved zeroes to leave room for a future purpose byte without changing the
 * nonce length.
 */
export function nonceForFrame(frameIndex: number): Uint8Array {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new Error('Frame index out of range');
  }
  const out = new Uint8Array(NONCE_BYTES);
  let remaining = frameIndex;
  for (let i = NONCE_BYTES - 1; i >= 4; i -= 1) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining !== 0) throw new Error('Frame index exceeds the nonce counter space');
  return out;
}

export { concat };
