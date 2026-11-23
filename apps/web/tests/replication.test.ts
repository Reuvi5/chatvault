/**
 * Replication, verification and the dead-letter path (plan §7, §11 milestone 3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_REPLICATION_ATTEMPTS } from '@chatvault/protocol';
import {
  cleanupDataDir,
  createAccount,
  getEnv,
  getStore,
  importFixture,
  readerFor,
  type TestAccount,
} from './harness';
import { reconcile, runReplication } from '@/server/services/replication';

let account: TestAccount;

beforeAll(async () => {
  account = await createAccount();
}, 120_000);

afterAll(async () => {
  await cleanupDataDir();
});

function providerPath(role: 'primary' | 'secondary', storageKey: string): string {
  const env = getEnv();
  const directory = role === 'primary' ? env.primary.directory : env.secondary?.directory;
  if (!directory) throw new Error('This test needs the local driver');
  return join(directory, 'objects', storageKey);
}

describe('two independent copies', () => {
  it('is not verified until the second copy exists and matches', async () => {
    const { outcome } = await importFixture(account, { messageCount: 10, seed: 31 });
    const store = await getStore();

    const beforeConversation = await store.get('conversations', outcome.conversationId);
    expect(beforeConversation?.archive_verified).toBe(false);
    const beforeStatus = await account.api.importStatus(outcome.importId);
    expect(beforeStatus.archiveVerified).toBe(false);
    expect(beforeStatus.objects.verified).toBe(0);

    const result = await account.api.runReplication(500);
    expect(result.failed).toBe(0);
    expect(result.verified).toBeGreaterThan(0);

    const afterStatus = await account.api.importStatus(outcome.importId);
    expect(afterStatus.archiveVerified).toBe(true);
    expect(afterStatus.objects.verified).toBe(afterStatus.objects.total);

    const objects = await store.find('objects', { equals: { import_id: outcome.importId } });
    for (const object of objects) {
      const replicas = await store.find('replicas', { equals: { object_id: object.id } });
      expect(replicas).toHaveLength(2);
      expect(replicas.every((replica) => replica.state === 'verified')).toBe(true);
      expect(new Set(replicas.map((replica) => replica.provider)).size).toBe(2);
      for (const replica of replicas) {
        expect(replica.ciphertext_sha256).toBe(object.ciphertext_sha256);
      }
      // Both files really are on disk, in two separate directories.
      await expect(stat(providerPath('primary', object.storage_key))).resolves.toBeTruthy();
      await expect(stat(providerPath('secondary', object.storage_key))).resolves.toBeTruthy();
    }
  });

  it('is idempotent: running it again verifies rather than re-uploads', async () => {
    const store = await getStore();
    const result = await runReplication(store, { limit: 500, accountId: account.accountId });
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('serves a read from the backup copy when the primary file is gone', async () => {
    const { outcome } = await importFixture(account, { messageCount: 8, seed: 32, withMedia: false });
    await account.api.runReplication(500);

    const store = await getStore();
    const page = outcome.manifest.pages[0];
    const object = await store.get('objects', page?.objectId as string);
    if (!object) throw new Error('missing object');

    await rm(providerPath('primary', object.storage_key), { force: true });

    const authorization = await account.api.authorizeDownload(object.id);
    expect(authorization.servedBy).toBe('secondary');

    const reader = await readerFor(account);
    const messages = await reader.loadPage(page as never);
    expect(messages.length).toBe(page?.messageCount);
  });
});

describe('when the backup copy cannot be made', () => {
  it('retries, then parks the object and refuses to call the archive verified', async () => {
    const { outcome } = await importFixture(account, {
      messageCount: 6,
      seed: 33,
      withMedia: false,
    });
    const store = await getStore();
    const objects = await store.find('objects', { equals: { import_id: outcome.importId } });
    const victim = objects.find((object) => object.kind === 'page');
    if (!victim) throw new Error('no page object');

    // The source disappears before the copy is made: the worker must notice.
    await rm(providerPath('primary', victim.storage_key), { force: true });

    let lastFailed = 0;
    for (let attempt = 0; attempt < MAX_REPLICATION_ATTEMPTS; attempt += 1) {
      const result = await runReplication(store, { limit: 500, accountId: account.accountId });
      lastFailed = result.failed + result.deadLettered;
    }
    expect(lastFailed).toBeGreaterThan(0);

    const replica = (
      await store.find('replicas', { equals: { object_id: victim.id } })
    ).find((candidate) => candidate.provider !== 'primary-test');
    expect(replica?.state).toBe('failed');
    expect(replica?.attempts).toBeGreaterThanOrEqual(MAX_REPLICATION_ATTEMPTS);
    expect(replica?.last_error).toBeTruthy();

    const parked = await store.get('objects', victim.id);
    expect(parked?.state).toBe('replication_failed');

    const conversation = await store.get('conversations', outcome.conversationId);
    expect(conversation?.archive_verified).toBe(false);

    const status = await account.api.importStatus(outcome.importId);
    expect(status.objects.failed).toBeGreaterThan(0);
    expect(status.archiveVerified).toBe(false);
  });

  it('stops retrying once an object is parked', async () => {
    const store = await getStore();
    const result = await runReplication(store, { limit: 500, accountId: account.accountId });
    expect(result.processed).toBe(0);
  });
});

describe('scheduled reconciliation', () => {
  it('notices a copy that has gone missing since it was verified', async () => {
    const { outcome } = await importFixture(account, {
      messageCount: 5,
      seed: 34,
      withMedia: false,
    });
    await account.api.runReplication(500);

    const store = await getStore();
    const objects = await store.find('objects', {
      equals: { import_id: outcome.importId, state: 'verified' },
    });
    const victim = objects[0];
    if (!victim) throw new Error('nothing was verified');
    await rm(providerPath('secondary', victim.storage_key), { force: true });

    const result = await reconcile(store, { sampleSize: 200 });
    expect(result.checked).toBeGreaterThan(0);
    expect(
      result.mismatches.some(
        (mismatch) => mismatch.objectId === victim.id && mismatch.detail === 'missing',
      ),
    ).toBe(true);
  });
});
