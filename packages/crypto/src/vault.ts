/**
 * Vault key management (plan §6.3 items 1-4, 9).
 *
 *   vault master key (32 random bytes)
 *     ├─ wrapped with Argon2id(passphrase)        → bundle.passphrase
 *     ├─ wrapped with HKDF(offline recovery key)  → bundle.recovery
 *     └─ HKDF subkeys per class of data           → objects / manifests / index / source
 *
 * The server stores only the wrapped forms plus non-secret KDF parameters, so it
 * can never derive the master key. Both wraps bind the bundle's own parameters
 * as additional authenticated data, so a tampered bundle fails to unwrap rather
 * than silently producing the wrong key.
 */
import { VAULT_BUNDLE_VERSION } from '@chatvault/protocol';
import { canonicalJson, fromBase64, toBase64, toHex, toUtf8, zero } from './bytes';
import {
  AuthenticationError,
  DEFAULT_ARGON2ID_PARAMS,
  KEY_BYTES,
  NONCE_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveArgon2id,
  hkdfSha256,
  importAesKey,
  randomBytes,
  sha256,
  type Argon2idParams,
} from './primitives';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from './recoveryKey';

export interface VaultKdfDescriptor {
  alg: 'argon2id';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltB64: string;
}

export interface WrappedBlob {
  nonceB64: string;
  ctB64: string;
}

export interface VaultBundle {
  v: number;
  keyId: string;
  createdAtMs: number;
  kdf: VaultKdfDescriptor;
  passphrase: WrappedBlob;
  recovery: WrappedBlob & { saltB64: string };
}

export interface UnlockedVault {
  /** The master key. Never leaves the device and is never persisted. */
  readonly key: Uint8Array;
  readonly keyId: string;
  readonly bundle: VaultBundle;
}

export type SubkeyPurpose = 'objects' | 'manifests' | 'index' | 'source';

/** Short, non-secret fingerprint used to detect a mismatched bundle or key. */
export async function vaultKeyId(key: Uint8Array): Promise<string> {
  const digest = await sha256(
    await hkdfSha256(key, new Uint8Array(32), toUtf8('chatvault/keyid/v1')),
  );
  return toHex(digest.subarray(0, 8));
}

export async function deriveSubkey(key: Uint8Array, purpose: SubkeyPurpose): Promise<Uint8Array> {
  return hkdfSha256(key, new Uint8Array(32), toUtf8(`chatvault/subkey/v1/${purpose}`));
}

function wrapAad(bundleCore: {
  v: number;
  keyId: string;
  purpose: 'passphrase' | 'recovery';
  kdf: VaultKdfDescriptor | { alg: 'hkdf-sha256'; saltB64: string };
}): Uint8Array {
  return toUtf8(canonicalJson(bundleCore));
}

async function passphraseWrappingKey(
  passphrase: string,
  kdf: VaultKdfDescriptor,
): Promise<Uint8Array> {
  return deriveArgon2id(passphrase, fromBase64(kdf.saltB64), {
    memoryKiB: kdf.memoryKiB,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
  });
}

async function recoveryWrappingKey(
  recoveryBytes: Uint8Array,
  saltB64: string,
): Promise<Uint8Array> {
  return hkdfSha256(recoveryBytes, fromBase64(saltB64), toUtf8('chatvault/recovery/v1'));
}

export interface CreateVaultOptions {
  argon2?: Argon2idParams;
  nowMs?: number;
}

export interface CreatedVault {
  vault: UnlockedVault;
  /** Show this once, then forget it. We never store it. */
  recoveryKeyDisplay: string;
}

export async function createVault(
  passphrase: string,
  options: CreateVaultOptions = {},
): Promise<CreatedVault> {
  assertUsablePassphrase(passphrase);
  const params = options.argon2 ?? DEFAULT_ARGON2ID_PARAMS;
  const masterKey = randomBytes(KEY_BYTES);
  const keyId = await vaultKeyId(masterKey);
  const kdf: VaultKdfDescriptor = {
    alg: 'argon2id',
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    saltB64: toBase64(randomBytes(16)),
  };
  const recovery = generateRecoveryKey();
  const recoverySaltB64 = toBase64(randomBytes(16));

  const bundle: VaultBundle = {
    v: VAULT_BUNDLE_VERSION,
    keyId,
    createdAtMs: options.nowMs ?? Date.now(),
    kdf,
    passphrase: await wrap(masterKey, await passphraseWrappingKey(passphrase, kdf), {
      v: VAULT_BUNDLE_VERSION,
      keyId,
      purpose: 'passphrase',
      kdf,
    }),
    recovery: {
      saltB64: recoverySaltB64,
      ...(await wrap(masterKey, await recoveryWrappingKey(recovery.bytes, recoverySaltB64), {
        v: VAULT_BUNDLE_VERSION,
        keyId,
        purpose: 'recovery',
        kdf: { alg: 'hkdf-sha256', saltB64: recoverySaltB64 },
      })),
    },
  };

  const display = formatRecoveryKey(recovery.bytes);
  zero(recovery.bytes);
  return { vault: { key: masterKey, keyId, bundle }, recoveryKeyDisplay: display };
}

async function wrap(
  masterKey: Uint8Array,
  wrappingKeyRaw: Uint8Array,
  aad: Parameters<typeof wrapAad>[0],
): Promise<WrappedBlob> {
  const nonce = randomBytes(NONCE_BYTES);
  const key = await importAesKey(wrappingKeyRaw);
  const ct = await aesGcmEncrypt(key, nonce, masterKey, wrapAad(aad));
  zero(wrappingKeyRaw);
  return { nonceB64: toBase64(nonce), ctB64: toBase64(ct) };
}

async function unwrap(
  blob: WrappedBlob,
  wrappingKeyRaw: Uint8Array,
  aad: Parameters<typeof wrapAad>[0],
): Promise<Uint8Array> {
  const key = await importAesKey(wrappingKeyRaw);
  const out = await aesGcmDecrypt(
    key,
    fromBase64(blob.nonceB64),
    fromBase64(blob.ctB64),
    wrapAad(aad),
  );
  zero(wrappingKeyRaw);
  if (out.byteLength !== KEY_BYTES) throw new AuthenticationError('Unwrapped key has a bad length');
  return out;
}

export async function unlockWithPassphrase(
  bundle: VaultBundle,
  passphrase: string,
): Promise<UnlockedVault> {
  assertSupportedBundle(bundle);
  const masterKey = await unwrap(
    bundle.passphrase,
    await passphraseWrappingKey(passphrase, bundle.kdf),
    { v: bundle.v, keyId: bundle.keyId, purpose: 'passphrase', kdf: bundle.kdf },
  );
  return finishUnlock(bundle, masterKey);
}

export async function unlockWithRecoveryKey(
  bundle: VaultBundle,
  recoveryKey: string,
): Promise<UnlockedVault> {
  assertSupportedBundle(bundle);
  const recoveryBytes = parseRecoveryKey(recoveryKey);
  const masterKey = await unwrap(
    bundle.recovery,
    await recoveryWrappingKey(recoveryBytes, bundle.recovery.saltB64),
    {
      v: bundle.v,
      keyId: bundle.keyId,
      purpose: 'recovery',
      kdf: { alg: 'hkdf-sha256', saltB64: bundle.recovery.saltB64 },
    },
  );
  zero(recoveryBytes);
  return finishUnlock(bundle, masterKey);
}

async function finishUnlock(bundle: VaultBundle, masterKey: Uint8Array): Promise<UnlockedVault> {
  const keyId = await vaultKeyId(masterKey);
  if (keyId !== bundle.keyId) {
    zero(masterKey);
    throw new AuthenticationError('Unlocked key does not match this vault');
  }
  return { key: masterKey, keyId, bundle };
}

function assertSupportedBundle(bundle: VaultBundle): void {
  if (bundle.v !== VAULT_BUNDLE_VERSION) {
    throw new Error(
      `This archive was written by a newer version of ChatVault (bundle v${String(bundle.v)}). Update the app to open it.`,
    );
  }
  if (bundle.kdf.alg !== 'argon2id') throw new Error('Unsupported key derivation function');
}

/** Re-wrap the same master key under a new passphrase; the archive is untouched. */
export async function rewrapWithPassphrase(
  vault: UnlockedVault,
  newPassphrase: string,
  options: CreateVaultOptions = {},
): Promise<VaultBundle> {
  assertUsablePassphrase(newPassphrase);
  const params = options.argon2 ?? {
    memoryKiB: vault.bundle.kdf.memoryKiB,
    iterations: vault.bundle.kdf.iterations,
    parallelism: vault.bundle.kdf.parallelism,
  };
  const kdf: VaultKdfDescriptor = {
    alg: 'argon2id',
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    saltB64: toBase64(randomBytes(16)),
  };
  return {
    ...vault.bundle,
    kdf,
    passphrase: await wrap(vault.key, await passphraseWrappingKey(newPassphrase, kdf), {
      v: vault.bundle.v,
      keyId: vault.keyId,
      purpose: 'passphrase',
      kdf,
    }),
  };
}

/** Issue a fresh recovery key, invalidating the previous one. */
export async function rotateRecoveryKey(
  vault: UnlockedVault,
): Promise<{ bundle: VaultBundle; recoveryKeyDisplay: string }> {
  const recovery = generateRecoveryKey();
  const saltB64 = toBase64(randomBytes(16));
  const wrapped = await wrap(vault.key, await recoveryWrappingKey(recovery.bytes, saltB64), {
    v: vault.bundle.v,
    keyId: vault.keyId,
    purpose: 'recovery',
    kdf: { alg: 'hkdf-sha256', saltB64 },
  });
  const display = formatRecoveryKey(recovery.bytes);
  zero(recovery.bytes);
  return {
    bundle: { ...vault.bundle, recovery: { saltB64, ...wrapped } },
    recoveryKeyDisplay: display,
  };
}

export function lockVault(vault: UnlockedVault): void {
  zero(vault.key);
}

/* ------------------------------------------------------- passphrase guidance */

export interface PassphraseAssessment {
  ok: boolean;
  /** Rough guess at guessing-resistance, in bits. Deliberately conservative. */
  estimatedBits: number;
  problems: string[];
  suggestions: string[];
}

const COMMON_PATTERNS = [
  /^(.)\1+$/u,
  /^(?:password|passphrase|letmein|welcome|qwerty|iloveyou|chatvault|whatsapp)/iu,
  /^(?:0123|1234|abcd|aaaa)/iu,
];

export function assessPassphrase(passphrase: string): PassphraseAssessment {
  const problems: string[] = [];
  const suggestions: string[] = [];
  const length = [...passphrase].length;

  if (length < 12) problems.push('Use at least 12 characters.');
  if (COMMON_PATTERNS.some((re) => re.test(passphrase))) {
    problems.push('That looks like a very common passphrase.');
  }

  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((re) =>
    re.test(passphrase),
  ).length;
  const words = passphrase.trim().split(/\s+/u).filter(Boolean).length;
  const alphabet = classes === 0 ? 1 : 10 * classes + 16;
  const estimatedBits = Math.round(length * Math.log2(alphabet));

  if (estimatedBits < 60) {
    suggestions.push('Four or five unrelated words are easier to remember and harder to guess.');
  }
  if (words === 1 && length < 20) suggestions.push('Try a short sentence instead of one word.');

  return { ok: problems.length === 0, estimatedBits, problems, suggestions };
}

export function assertUsablePassphrase(passphrase: string): void {
  const result = assessPassphrase(passphrase);
  if (!result.ok) throw new Error(result.problems.join(' '));
}
