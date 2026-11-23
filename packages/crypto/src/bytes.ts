/** Byte helpers shared by every crypto routine. No cryptography lives here. */

export const utf8 = new TextEncoder();
export const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function toUtf8(value: string): Uint8Array {
  return utf8.encode(value);
}

export function fromUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Hex string has an odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Hex string contains a non-hex character');
    out[i] = byte;
  }
  return out;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64, implemented directly so the code runs identically in both runtimes. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 63];
  }
  return out;
}

export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = B64_CHARS.indexOf(char);
    if (index < 0) throw new Error('Invalid base64 input');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

export function writeUint16BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error('uint16 out of range');
  }
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

export function writeUint32BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('uint32 out of range');
  }
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

export function readUint16BE(bytes: Uint8Array, offset = 0): number {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  if (a === undefined || b === undefined) throw new Error('Truncated uint16');
  return (a << 8) | b;
}

export function readUint32BE(bytes: Uint8Array, offset = 0): number {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error('Truncated uint32');
  }
  return a * 0x1000000 + ((b << 16) | (c << 8) | d);
}

/** Big-endian 64-bit counter, used for frame nonces and frame AAD. */
export function writeUint64BE(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('uint64 out of range');
  const out = new Uint8Array(8);
  let remaining = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/** Comparison whose duration does not depend on where the first difference is. */
export function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Best-effort wipe of key material once it is no longer needed. */
export function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * Deterministic JSON serialization, so a structure used as additional
 * authenticated data produces identical bytes on every runtime.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) out[key] = sortDeep(item);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Cannot canonicalize a non-finite number');
  }
  return value;
}
