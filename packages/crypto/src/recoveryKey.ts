/**
 * The offline recovery key (plan §6.3 item 9).
 *
 * 32 random bytes, shown to the person once, in Crockford base32 with a CRC-16
 * checksum so a mistyped character is caught before we claim the key is wrong.
 * Crockford's alphabet omits I, L, O and U; on input we fold the usual
 * look-alikes, accept any spacing and accept lower case.
 */
import { randomBytes } from './primitives';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 32;
const CHECKSUM_BYTES = 2;
const PAYLOAD_BYTES = KEY_BYTES + CHECKSUM_BYTES;
const ENCODED_CHARS = Math.ceil((PAYLOAD_BYTES * 8) / 5); // 55
const GROUP = 5;
export const RECOVERY_KEY_PREFIX = 'CV1';

/** CRC-16/CCITT-FALSE. A typo check, not a security control. */
function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string, expectedBytes: number): Uint8Array {
  const out = new Uint8Array(expectedBytes);
  let index = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new RecoveryKeyError('That recovery key contains unexpected characters.');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (index < expectedBytes) {
        out[index] = (buffer >>> bits) & 0xff;
        index += 1;
      }
    }
  }
  if (index !== expectedBytes) throw new RecoveryKeyError('That recovery key is the wrong length.');
  return out;
}

export class RecoveryKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryKeyError';
  }
}

export interface GeneratedRecoveryKey {
  /** The raw key. Keep it in memory only as long as it is needed. */
  bytes: Uint8Array;
  /** The grouped string shown to the person. */
  display: string;
}

export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.byteLength !== KEY_BYTES) throw new RecoveryKeyError('A recovery key is 32 bytes.');
  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload.set(bytes, 0);
  const sum = crc16(bytes);
  payload[KEY_BYTES] = (sum >> 8) & 0xff;
  payload[KEY_BYTES + 1] = sum & 0xff;
  const encoded = base32Encode(payload);
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += GROUP) groups.push(encoded.slice(i, i + GROUP));
  return `${RECOVERY_KEY_PREFIX}-${groups.join('-')}`;
}

export function generateRecoveryKey(): GeneratedRecoveryKey {
  const bytes = randomBytes(KEY_BYTES);
  return { bytes, display: formatRecoveryKey(bytes) };
}

export function parseRecoveryKey(input: string): Uint8Array {
  // Strip spacing and punctuation first, then the version prefix, and only then
  // fold look-alike characters: folding first would mangle the prefix itself.
  let body = input.toUpperCase().replace(/[^0-9A-Z]/gu, '');
  if (body.length === ENCODED_CHARS + RECOVERY_KEY_PREFIX.length && body.startsWith('CV')) {
    body = body.slice(RECOVERY_KEY_PREFIX.length);
  }
  const normalized = body.replace(/O/gu, '0').replace(/[IL]/gu, '1');
  if (normalized.length === 0) throw new RecoveryKeyError('Enter your recovery key.');
  if (normalized.length !== ENCODED_CHARS) {
    throw new RecoveryKeyError(
      `A recovery key has ${String(ENCODED_CHARS)} characters after the CV1 prefix; this one has ${String(
        normalized.length,
      )}.`,
    );
  }
  const payload = base32Decode(normalized, PAYLOAD_BYTES);
  const key = payload.subarray(0, KEY_BYTES);
  const expected = crc16(key);
  const actual = ((payload[KEY_BYTES] as number) << 8) | (payload[KEY_BYTES + 1] as number);
  if (expected !== actual) {
    throw new RecoveryKeyError(
      'That recovery key failed its checksum, so a character is probably wrong. Check it and try again.',
    );
  }
  return new Uint8Array(key);
}
