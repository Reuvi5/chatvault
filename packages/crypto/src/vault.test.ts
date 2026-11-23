import { describe, expect, it } from 'vitest';
import { toHex } from './bytes';
import { AuthenticationError, FAST_ARGON2ID_PARAMS, randomBytes } from './primitives';
import {
  assessPassphrase,
  createVault,
  deriveSubkey,
  rewrapWithPassphrase,
  rotateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  vaultKeyId,
} from './vault';
import { decryptJsonObject, encryptJsonObject } from './documents';

const argon2 = FAST_ARGON2ID_PARAMS;
const PASSPHRASE = 'seventeen velvet otters argue';

async function makeVault() {
  return createVault(PASSPHRASE, { argon2 });
}

describe('vault creation', () => {
  it('stores only wrapped key material and non-secret parameters', async () => {
    const { vault } = await makeVault();
    const serialized = JSON.stringify(vault.bundle);
    expect(serialized).not.toContain(PASSPHRASE);
    expect(serialized).not.toContain(toHex(vault.key));
    expect(vault.bundle.kdf.alg).toBe('argon2id');
    expect(vault.bundle.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('issues a recovery key that is never persisted in the bundle', async () => {
    const { vault, recoveryKeyDisplay } = await makeVault();
    expect(recoveryKeyDisplay.startsWith('CV1-')).toBe(true);
    expect(JSON.stringify(vault.bundle)).not.toContain(recoveryKeyDisplay.slice(4, 12));
  });

  it('refuses a passphrase that is too short', async () => {
    await expect(createVault('short', { argon2 })).rejects.toThrow(/at least 12/i);
  });
});

describe('unlocking', () => {
  it('recovers the same master key from the passphrase', async () => {
    const { vault } = await makeVault();
    const again = await unlockWithPassphrase(vault.bundle, PASSPHRASE);
    expect(toHex(again.key)).toBe(toHex(vault.key));
  });

  it('recovers the same master key from the offline recovery key alone', async () => {
    const { vault, recoveryKeyDisplay } = await makeVault();
    const again = await unlockWithRecoveryKey(vault.bundle, recoveryKeyDisplay);
    expect(toHex(again.key)).toBe(toHex(vault.key));
  });

  it('rejects a wrong passphrase without saying why', async () => {
    const { vault } = await makeVault();
    await expect(unlockWithPassphrase(vault.bundle, `${PASSPHRASE}!`)).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('rejects a recovery key from a different vault', async () => {
    const a = await makeVault();
    const b = await makeVault();
    await expect(unlockWithRecoveryKey(a.vault.bundle, b.recoveryKeyDisplay)).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('rejects a bundle whose parameters were altered', async () => {
    const { vault } = await makeVault();
    const tampered = structuredClone(vault.bundle);
    tampered.kdf.iterations += 1;
    await expect(unlockWithPassphrase(tampered, PASSPHRASE)).rejects.toThrow(AuthenticationError);

    const swappedId = structuredClone(vault.bundle);
    swappedId.keyId = 'ffffffffffffffff';
    await expect(unlockWithPassphrase(swappedId, PASSPHRASE)).rejects.toThrow(AuthenticationError);
  });

  it('refuses a bundle written by a newer format version', async () => {
    const { vault } = await makeVault();
    const future = { ...structuredClone(vault.bundle), v: 99 };
    await expect(unlockWithPassphrase(future, PASSPHRASE)).rejects.toThrow(/newer version/i);
  });
});

describe('key rotation', () => {
  it('changes the passphrase without touching the archive key', async () => {
    const { vault } = await makeVault();
    const bundle = await rewrapWithPassphrase(vault, 'a different long passphrase', { argon2 });
    const reopened = await unlockWithPassphrase(bundle, 'a different long passphrase');
    expect(toHex(reopened.key)).toBe(toHex(vault.key));
    await expect(unlockWithPassphrase(bundle, PASSPHRASE)).rejects.toThrow(AuthenticationError);
  });

  it('issues a new recovery key and invalidates the old one', async () => {
    const { vault, recoveryKeyDisplay } = await makeVault();
    const rotated = await rotateRecoveryKey(vault);
    expect(rotated.recoveryKeyDisplay).not.toBe(recoveryKeyDisplay);
    const reopened = await unlockWithRecoveryKey(rotated.bundle, rotated.recoveryKeyDisplay);
    expect(toHex(reopened.key)).toBe(toHex(vault.key));
    await expect(unlockWithRecoveryKey(rotated.bundle, recoveryKeyDisplay)).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('keeps data readable across a passphrase change', async () => {
    const { vault } = await makeVault();
    const material = await deriveSubkey(vault.key, 'manifests');
    const { bytes } = await encryptJsonObject({
      material,
      objectId: 'obj_aaaaaaaaaaaaaaaaaaaaaa',
      kind: 'manifest',
      value: { hello: 'world' },
    });
    const bundle = await rewrapWithPassphrase(vault, 'yet another long passphrase', { argon2 });
    const reopened = await unlockWithPassphrase(bundle, 'yet another long passphrase');
    const decoded = await decryptJsonObject<{ hello: string }>({
      material: await deriveSubkey(reopened.key, 'manifests'),
      bytes,
    });
    expect(decoded.hello).toBe('world');
  });
});

describe('subkey separation', () => {
  it('derives a different key per purpose and per vault', async () => {
    const { vault } = await makeVault();
    const purposes = ['objects', 'manifests', 'index', 'source'] as const;
    const keys = await Promise.all(purposes.map((p) => deriveSubkey(vault.key, p)));
    expect(new Set(keys.map(toHex)).size).toBe(purposes.length);

    const other = await makeVault();
    expect(toHex(await deriveSubkey(other.vault.key, 'objects'))).not.toBe(toHex(keys[0] as Uint8Array));
  });

  it('cannot read a manifest with the objects subkey', async () => {
    const { vault } = await makeVault();
    const { bytes } = await encryptJsonObject({
      material: await deriveSubkey(vault.key, 'manifests'),
      objectId: 'obj_bbbbbbbbbbbbbbbbbbbbbb',
      kind: 'manifest',
      value: { secret: true },
    });
    await expect(
      decryptJsonObject({ material: await deriveSubkey(vault.key, 'objects'), bytes }),
    ).rejects.toThrow(AuthenticationError);
  });

  it('derives a stable key identifier', async () => {
    const key = randomBytes(32);
    expect(await vaultKeyId(key)).toBe(await vaultKeyId(key));
    expect(await vaultKeyId(key)).not.toBe(await vaultKeyId(randomBytes(32)));
  });
});

describe('passphrase guidance', () => {
  it('rejects short and obvious passphrases', () => {
    expect(assessPassphrase('short').ok).toBe(false);
    expect(assessPassphrase('password1234').ok).toBe(false);
    expect(assessPassphrase('aaaaaaaaaaaaaaa').ok).toBe(false);
  });

  it('accepts a long passphrase and estimates its strength conservatively', () => {
    const result = assessPassphrase('seventeen velvet otters argue');
    expect(result.ok).toBe(true);
    expect(result.estimatedBits).toBeGreaterThan(80);
  });
});
