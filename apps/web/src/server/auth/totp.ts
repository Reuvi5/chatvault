/**
 * Time-based one-time passwords (RFC 6238), the second factor for sign-in.
 *
 * Plan §3 asks for "passkey or MFA where supported". This is the MFA path;
 * WebAuthn passkeys are listed as a follow-up in docs/DECISIONS.md rather than
 * half-built here.
 *
 * The shared secret is stored encrypted with the server key, because the server
 * has to be able to check a code. It has nothing to do with vault keys.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hkdfSync } from 'node:crypto';
import { getEnv } from '../env';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const STEP_SECONDS = 30;
/** Accept the previous and next window, for clock drift. */
const WINDOW = 1;

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

export function base32Decode(value: string): Uint8Array {
  const clean = value.toUpperCase().replace(/=+$/u, '').replace(/\s/gu, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 character in TOTP secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): { secret: Uint8Array; base32: string } {
  const secret = new Uint8Array(randomBytes(20));
  return { secret, base32: base32Encode(secret) };
}

function codeForCounter(secret: Uint8Array, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(secret)).update(buffer).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentTotp(secret: Uint8Array, atMs = Date.now()): string {
  return codeForCounter(secret, Math.floor(atMs / 1000 / STEP_SECONDS));
}

export function verifyTotp(secret: Uint8Array, code: string, atMs = Date.now()): boolean {
  const cleaned = code.replace(/\s/gu, '');
  if (!/^\d{6}$/u.test(cleaned)) return false;
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    const expected = Buffer.from(codeForCounter(secret, counter + offset));
    const given = Buffer.from(cleaned);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

export function otpauthUrl(email: string, base32Secret: string): string {
  const label = encodeURIComponent(`ChatVault:${email}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer: 'ChatVault',
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------- encryption of stored secrets */

function serverKey(purpose: string): Buffer {
  const env = getEnv();
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(env.serverSecret), Buffer.alloc(32), Buffer.from(purpose), 32),
  );
}

export function encryptSecret(plaintext: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', serverKey('chatvault/totp/v1'), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return [
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function decryptSecret(value: string): Uint8Array {
  const [ivPart, ciphertextPart, tagPart] = value.split('.');
  if (!ivPart || !ciphertextPart || !tagPart) throw new Error('Malformed stored secret');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    serverKey('chatvault/totp/v1'),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return new Uint8Array(
    Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64url')), decipher.final()]),
  );
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    base32Encode(new Uint8Array(randomBytes(10)))
      .replace(/=/gu, '')
      .slice(0, 16)
      .replace(/(.{4})(?=.)/gu, '$1-'),
  );
}
