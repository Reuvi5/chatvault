/**
 * Opaque identifiers.
 *
 * Plan §6 "Metadata minimization": identifiers must be random and must never
 * encode conversation names, phone numbers or file names.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no i/l/o/u

export type IdPrefix =
  | 'acc'
  | 'ses'
  | 'vlt'
  | 'cnv'
  | 'imp'
  | 'obj'
  | 'rep'
  | 'job'
  | 'evt'
  | 'bp'
  | 'usg'
  | 'idm';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** 128 bits of randomness, rendered in a 26-char base32 alphabet. */
export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return `${prefix}_${out}`;
}

const ID_RE = /^[a-z]{2,3}_[0-9a-hjkmnp-tv-z]{20,32}$/;

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== 'string' || !ID_RE.test(value)) return false;
  if (prefix && !value.startsWith(`${prefix}_`)) return false;
  return true;
}

/**
 * Storage key for an encrypted object. Contains only opaque identifiers, so a
 * bucket listing leaks no conversation names (plan §6 metadata minimization).
 */
export function objectStorageKey(accountId: string, objectId: string): string {
  return `v1/${accountId}/${objectId}`;
}
