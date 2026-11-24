/**
 * Login passwords.
 *
 * Argon2id, with the parameters stored alongside the hash so they can be raised
 * later without locking anyone out. This is entirely separate from the vault
 * passphrase: the server must be able to check a login, and must never be able
 * to derive a vault key.
 */
import { argon2id } from 'hash-wasm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../env';

export interface PasswordRecord {
  hash: string;
  params: string;
}

function encodeParams(
  memoryKiB: number,
  iterations: number,
  parallelism: number,
  salt: Uint8Array,
) {
  return `argon2id$m=${String(memoryKiB)},t=${String(iterations)},p=${String(parallelism)}$${Buffer.from(salt).toString('base64url')}`;
}

function decodeParams(params: string): {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
} {
  const match = /^argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)$/u.exec(params);
  if (!match) throw new Error('Unreadable password parameters');
  return {
    memoryKiB: Number(match[1]),
    iterations: Number(match[2]),
    parallelism: Number(match[3]),
    salt: new Uint8Array(Buffer.from(match[4] as string, 'base64url')),
  };
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const { passwordArgon2 } = getEnv();
  const salt = new Uint8Array(randomBytes(16));
  const hash = await argon2id({
    password,
    salt,
    memorySize: passwordArgon2.memoryKiB,
    iterations: passwordArgon2.iterations,
    parallelism: passwordArgon2.parallelism,
    hashLength: 32,
    outputType: 'hex',
  });
  return {
    hash,
    params: encodeParams(
      passwordArgon2.memoryKiB,
      passwordArgon2.iterations,
      passwordArgon2.parallelism,
      salt,
    ),
  };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  let parsed: ReturnType<typeof decodeParams>;
  try {
    parsed = decodeParams(record.params);
  } catch {
    return false;
  }
  const hash = await argon2id({
    password,
    salt: parsed.salt,
    memorySize: parsed.memoryKiB,
    iterations: parsed.iterations,
    parallelism: parsed.parallelism,
    hashLength: 32,
    outputType: 'hex',
  });
  const left = Buffer.from(hash, 'hex');
  const right = Buffer.from(record.hash, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Whether a stored hash was made with weaker parameters than we now use. */
export function needsRehash(record: PasswordRecord): boolean {
  try {
    const parsed = decodeParams(record.params);
    const current = getEnv().passwordArgon2;
    return (
      parsed.memoryKiB < current.memoryKiB ||
      parsed.iterations < current.iterations ||
      parsed.parallelism < current.parallelism
    );
  } catch {
    return true;
  }
}
