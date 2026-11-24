/**
 * Deletion and retention (plan §7, §14.5).
 *
 * What these tests pin down: deleting is reversible for a window, a purge really
 * removes both copies, and deleting an account removes everything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanupDataDir,
  createAccount,
  getEnv,
  getStore,
  importFixture,
  type TestAccount,
} from './harness';
import { purgeExpiredObjects, runDeletionJobs } from '@/server/services/deletion';

let account: TestAccount;

beforeAll(async () => {
  account = await createAccount();
}, 120_000);

afterAll(async () => {
  await cleanupDataDir();
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function providerPaths(storageKey: string): string[] {
  const env = getEnv();
  return [env.primary.directory, env.secondary?.directory]
    .filter((directory): directory is string => Boolean(directory))
    .map((directory) => join(directory, 'objects', storageKey));
}

describe('moving a conversation to the trash', () => {
  it('keeps both copies and stays restorable', async () => {
    const { outcome } = await importFixture(account, { messageCount: 10, seed: 41 });
    await account.api.runReplication(500);
    const store = await getStore();
    const objects = await store.find('objects', { equals: { import_id: outcome.importId } });

    await account.api.deleteConversation(outcome.conversationId, 'trash');

    const conversation = await store.get('conversations', outcome.conversationId);
    expect(conversation?.state).toBe('trashed');
    expect(conversation?.purge_after_ms).toBeGreaterThan(Date.now());
    expect(conversation?.logical_bytes).toBe(0);

    for (const object of objects) {
      const row = await store.get('objects', object.id);
      expect(row?.state).toBe('trashed');
      // Nothing was removed from either provider.
      for (const path of providerPaths(object.storage_key)) {
        expect(await exists(path)).toBe(true);
      }
    }

    // It is hidden from the normal list but visible with the trash included.
    const active = await account.api.conversations();
    expect(active.conversations.some((row) => row.id === outcome.conversationId)).toBe(false);

    const job = await store.findOne('deletion_jobs', {
      equals: { target_id: outcome.conversationId, state: 'scheduled' },
    });
    expect(job).not.toBeNull();
    expect(job?.execute_after_ms).toBeGreaterThan(Date.now());
  });

  it('restores it, and marks it verified again where both copies are good', async () => {
    const { outcome } = await importFixture(account, { messageCount: 8, seed: 42 });
    await account.api.runReplication(500);
    await account.api.deleteConversation(outcome.conversationId, 'trash');
    await account.api.restoreConversation(outcome.conversationId);

    const store = await getStore();
    const conversation = await store.get('conversations', outcome.conversationId);
    expect(conversation?.state).toBe('active');
    expect(conversation?.trashed_at_ms).toBeNull();
    expect(conversation?.logical_bytes).toBeGreaterThan(0);

    const objects = await store.find('objects', { equals: { import_id: outcome.importId } });
    expect(objects.every((object) => object.state === 'verified')).toBe(true);

    const cancelled = await store.findOne('deletion_jobs', {
      equals: { target_id: outcome.conversationId, state: 'scheduled' },
    });
    expect(cancelled).toBeNull();
  });

  it('cancels the scheduled purge if the conversation was restored', async () => {
    const { outcome } = await importFixture(account, {
      messageCount: 5,
      seed: 43,
      withMedia: false,
    });
    await account.api.deleteConversation(outcome.conversationId, 'trash');
    await account.api.restoreConversation(outcome.conversationId);

    const store = await getStore();
    const result = await runDeletionJobs(store, { nowMs: Date.now() + 100 * 24 * 3600 * 1000 });
    expect(result.failures).toBe(0);

    const conversation = await store.get('conversations', outcome.conversationId);
    expect(conversation?.state).toBe('active');
  });
});

describe('purging', () => {
  it('removes both copies and the metadata, and refuses without a typed confirmation', async () => {
    const { outcome } = await importFixture(account, { messageCount: 7, seed: 44 });
    await account.api.runReplication(500);
    const store = await getStore();
    const objects = await store.find('objects', { equals: { import_id: outcome.importId } });

    await expect(
      account.api.deleteConversation(outcome.conversationId, 'purge'),
    ).rejects.toMatchObject({ code: 'bad_request' });

    await account.api.deleteConversation(outcome.conversationId, 'purge', 'DELETE');

    expect(await store.get('conversations', outcome.conversationId)).toBeNull();
    for (const object of objects) {
      expect(await store.get('objects', object.id)).toBeNull();
      const replicas = await store.find('replicas', { equals: { object_id: object.id } });
      expect(replicas).toHaveLength(0);
      for (const path of providerPaths(object.storage_key)) {
        expect(await exists(path)).toBe(false);
      }
    }
    const usage = await account.api.usage();
    expect(usage.trashedBytes).toBe(0);
  });

  it('purges trashed objects once the retention window has passed', async () => {
    const { outcome } = await importFixture(account, {
      messageCount: 6,
      seed: 45,
      withMedia: false,
    });
    const store = await getStore();
    const objects = await store.find('objects', { equals: { import_id: outcome.importId } });
    await account.api.deleteConversation(outcome.conversationId, 'trash');

    const nothingYet = await purgeExpiredObjects(store, { nowMs: Date.now() });
    expect(nothingYet.purged).toBe(0);

    const later = Date.now() + 40 * 24 * 60 * 60 * 1000;
    const result = await purgeExpiredObjects(store, { nowMs: later, limit: 500 });
    expect(result.purged).toBe(objects.length);
    for (const object of objects) {
      for (const path of providerPaths(object.storage_key)) {
        expect(await exists(path)).toBe(false);
      }
    }
  });
});

describe('deleting an account', () => {
  it('schedules the work, signs the person out, and then removes everything', async () => {
    const victim = await createAccount();
    const { outcome } = await importFixture(victim, { messageCount: 6, seed: 46 });
    await victim.api.runReplication(500);

    const store = await getStore();
    const objects = await store.find('objects', { equals: { account_id: victim.accountId } });
    expect(objects.length).toBeGreaterThan(0);

    await victim.api.deleteAccount(victim.email, false);

    // Sessions are gone immediately.
    expect(await victim.api.session()).toBeNull();
    const marked = await store.get('accounts', victim.accountId);
    expect(marked?.state).toBe('deleting');

    const result = await runDeletionJobs(store, { nowMs: Date.now() + 40 * 24 * 3600 * 1000 });
    expect(result.failures).toBe(0);
    expect(result.objectsPurged).toBeGreaterThan(0);

    expect(await store.get('accounts', victim.accountId)).toBeNull();
    expect(await store.get('conversations', outcome.conversationId)).toBeNull();
    for (const object of objects) {
      for (const path of providerPaths(object.storage_key)) {
        expect(await exists(path)).toBe(false);
      }
    }
    for (const table of ['vaults', 'imports', 'usage_ledger', 'sessions'] as const) {
      expect(await store.count(table, { equals: { account_id: victim.accountId } })).toBe(0);
    }
  });

  it('refuses unless the email address is typed correctly', async () => {
    const other = await createAccount();
    await expect(other.api.deleteAccount('someone@else.test', false)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(await other.api.session()).not.toBeNull();
  });
});
