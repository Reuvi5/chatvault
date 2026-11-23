/**
 * Deletion (plan §7 "Define a consistent deletion policy", §14.5).
 *
 * The policy implemented here, and stated in the interface:
 *
 *  - Deleting a conversation moves it to the trash. It stays readable and
 *    restorable for the retention window (30 days by default, configurable).
 *  - Nothing is removed from either provider while it is in the trash, so an
 *    accidental or malicious deletion does not propagate to the backup.
 *  - A purge is a separate, deliberate job. It removes both copies and then the
 *    metadata, and it records how many objects it removed.
 *  - Trashed data is not billed, and the usage ledger records the drop at the
 *    moment of the move.
 */
import { newId } from '@chatvault/protocol';
import type { RowOf, Store } from '../db/index';
import { SERVICE_SCOPE } from '../db/index';
import { conflict, notFound } from '../http';
import { recordAudit } from '../security';
import { log } from '../log';
import { purgeObjectEverywhere } from './objects';
import { recordUsageSnapshot, trashRetentionMs } from './metering';

export interface TrashResult {
  conversationId: string;
  objectsTrashed: number;
  purgeAfterMs: number;
  retentionDays: number;
}

export async function trashConversation(
  store: Store,
  accountId: string,
  conversationId: string,
): Promise<TrashResult> {
  const conversation = await store.get('conversations', conversationId);
  if (!conversation || conversation.account_id !== accountId) {
    throw notFound('That conversation does not exist.');
  }
  if (conversation.state === 'purged') throw conflict('That conversation was already removed.');

  const now = Date.now();
  const retention = trashRetentionMs();
  const purgeAfterMs = now + retention;

  const objectsTrashed = await store.updateWhere(
    'objects',
    {
      equals: { conversation_id: conversationId, account_id: accountId },
      in: { column: 'state', values: ['primary_stored', 'verified', 'replication_failed'] },
    },
    { state: 'trashed', trashed_at_ms: now, purge_after_ms: purgeAfterMs, updated_at_ms: now },
  );

  await store.update('conversations', conversationId, {
    state: 'trashed',
    trashed_at_ms: now,
    purge_after_ms: purgeAfterMs,
    archive_verified: false,
    logical_bytes: 0,
    updated_at_ms: now,
  });

  await store.insert('deletion_jobs', {
    id: newId('job'),
    account_id: accountId,
    target_type: 'conversation',
    target_id: conversationId,
    mode: 'trash_then_purge',
    state: 'scheduled',
    objects_purged: 0,
    requested_at_ms: now,
    execute_after_ms: purgeAfterMs,
    completed_at_ms: null,
    last_error: null,
  });

  await recordUsageSnapshot(store, accountId, 'deletion');
  await recordAudit(store, {
    accountId,
    kind: 'conversation.trashed',
    detail: `${conversationId}: ${String(objectsTrashed)} objects, purge after ${new Date(purgeAfterMs).toISOString()}`,
  });

  return {
    conversationId,
    objectsTrashed,
    purgeAfterMs,
    retentionDays: Math.round(retention / (24 * 60 * 60 * 1000)),
  };
}

export async function restoreConversation(
  store: Store,
  accountId: string,
  conversationId: string,
): Promise<{ objectsRestored: number }> {
  const conversation = await store.get('conversations', conversationId);
  if (!conversation || conversation.account_id !== accountId) {
    throw notFound('That conversation does not exist.');
  }
  if (conversation.state === 'purged') {
    throw conflict('That conversation was purged and cannot be restored.');
  }
  if (conversation.state === 'active') return { objectsRestored: 0 };

  const now = Date.now();
  const objects = await store.find('objects', {
    equals: { conversation_id: conversationId, account_id: accountId, state: 'trashed' },
    limit: 500_000,
  });

  for (const object of objects) {
    const replicas = await store.find('replicas', { equals: { object_id: object.id } });
    const verified = replicas.length >= 2 && replicas.every((replica) => replica.state === 'verified');
    await store.update('objects', object.id, {
      state: verified ? 'verified' : 'primary_stored',
      trashed_at_ms: null,
      purge_after_ms: null,
      updated_at_ms: now,
    });
  }

  const logicalBytes = objects.reduce((sum, object) => sum + object.ciphertext_bytes, 0);
  await store.update('conversations', conversationId, {
    state: 'active',
    trashed_at_ms: null,
    purge_after_ms: null,
    logical_bytes: logicalBytes,
    updated_at_ms: now,
  });
  await store.removeWhere('deletion_jobs', {
    equals: { target_id: conversationId, state: 'scheduled' },
  });

  await recordUsageSnapshot(store, accountId, 'snapshot');
  await recordAudit(store, {
    accountId,
    kind: 'conversation.restored',
    detail: `${conversationId}: ${String(objects.length)} objects`,
  });
  return { objectsRestored: objects.length };
}

export interface PurgeResult {
  objectsPurged: number;
  objectsFailed: number;
}

export async function purgeConversation(
  store: Store,
  accountId: string,
  conversationId: string,
): Promise<PurgeResult> {
  const conversation = await store.get('conversations', conversationId);
  if (!conversation || conversation.account_id !== accountId) {
    throw notFound('That conversation does not exist.');
  }

  const objects = await store.find('objects', {
    equals: { conversation_id: conversationId, account_id: accountId },
    limit: 500_000,
  });

  let purged = 0;
  let failed = 0;
  for (const object of objects) {
    const result = await purgeObjectEverywhere(store, object);
    if (result.failed.length === 0) purged += 1;
    else failed += 1;
  }

  await store.removeWhere('imports', { equals: { conversation_id: conversationId } });
  if (failed === 0) {
    await store.remove('conversations', conversationId);
  } else {
    await store.update('conversations', conversationId, {
      state: 'trashed',
      updated_at_ms: Date.now(),
      purge_after_ms: Date.now() + 60 * 60 * 1000,
    });
  }

  await recordUsageSnapshot(store, accountId, 'purge');
  await recordAudit(store, {
    accountId,
    kind: 'conversation.purged',
    detail: `${conversationId}: ${String(purged)} objects removed, ${String(failed)} failed`,
  });
  return { objectsPurged: purged, objectsFailed: failed };
}

export async function requestAccountDeletion(
  store: Store,
  account: RowOf<'accounts'>,
  purgeImmediately: boolean,
): Promise<{ executeAfterMs: number }> {
  const now = Date.now();
  const executeAfterMs = purgeImmediately ? now : now + trashRetentionMs();

  await store.update('accounts', account.id, {
    state: 'deleting',
    updated_at_ms: now,
    deleted_at_ms: null,
  });
  await store.removeWhere('sessions', { equals: { account_id: account.id } });
  await store.insert('deletion_jobs', {
    id: newId('job'),
    account_id: account.id,
    target_type: 'account',
    target_id: account.id,
    mode: purgeImmediately ? 'purge_now' : 'trash_then_purge',
    state: 'scheduled',
    objects_purged: 0,
    requested_at_ms: now,
    execute_after_ms: executeAfterMs,
    completed_at_ms: null,
    last_error: null,
  });
  await recordAudit(store, {
    accountId: account.id,
    kind: 'account.deletion_requested',
    detail: purgeImmediately ? 'immediate purge requested' : `purge scheduled for ${new Date(executeAfterMs).toISOString()}`,
  });
  return { executeAfterMs };
}

async function purgeAccount(store: Store, accountId: string): Promise<number> {
  const conversations = await store.find('conversations', {
    equals: { account_id: accountId },
    limit: 100_000,
  });
  let purged = 0;
  for (const conversation of conversations) {
    const result = await purgeConversation(store, accountId, conversation.id);
    purged += result.objectsPurged;
  }

  // Anything left over: objects not attached to a surviving conversation.
  const strays = await store.find('objects', { equals: { account_id: accountId }, limit: 100_000 });
  for (const object of strays) {
    const result = await purgeObjectEverywhere(store, object);
    if (result.failed.length === 0) purged += 1;
  }

  for (const table of [
    'upload_sessions',
    'replicas',
    'imports',
    'conversations',
    'usage_ledger',
    'billing_periods',
    'vaults',
    'sessions',
    'idempotency_keys',
    'security_audit_events',
  ] as const) {
    await store.removeWhere(table, { equals: { account_id: accountId } });
  }
  await store.remove('accounts', accountId);
  return purged;
}

export async function runDeletionJobs(
  store: Store,
  options: { limit?: number; nowMs?: number } = {},
): Promise<{ jobs: number; objectsPurged: number; failures: number }> {
  const now = options.nowMs ?? Date.now();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);

  return store.transaction(SERVICE_SCOPE, async (tx) => {
    const due = await tx.find('deletion_jobs', {
      equals: { state: 'scheduled' },
      lessThanOrEqual: { column: 'execute_after_ms', value: now },
      orderBy: { column: 'execute_after_ms', direction: 'asc' },
      limit,
    });

    let objectsPurged = 0;
    let failures = 0;

    for (const job of due) {
      try {
        if (job.target_type === 'conversation') {
          const conversation = await tx.get('conversations', job.target_id);
          if (!conversation) {
            await tx.update('deletion_jobs', job.id, { state: 'completed', completed_at_ms: now });
            continue;
          }
          if (conversation.state !== 'trashed') {
            // Restored in the meantime: the job no longer applies.
            await tx.update('deletion_jobs', job.id, { state: 'cancelled', completed_at_ms: now });
            continue;
          }
          const result = await purgeConversation(tx, job.account_id, job.target_id);
          objectsPurged += result.objectsPurged;
          await tx.update('deletion_jobs', job.id, {
            state: result.objectsFailed === 0 ? 'completed' : 'failed',
            objects_purged: result.objectsPurged,
            completed_at_ms: now,
            last_error: result.objectsFailed === 0 ? null : `${String(result.objectsFailed)} objects could not be removed`,
          });
        } else {
          const removed = await purgeAccount(tx, job.target_id);
          objectsPurged += removed;
          await tx.insert('security_audit_events', {
            id: newId('evt'),
            account_id: null,
            kind: 'account.deletion_requested',
            detail: `an account was purged: ${String(removed)} objects removed`,
            client_hash: null,
            at_ms: now,
          });
        }
      } catch (error) {
        failures += 1;
        log.error('A deletion job failed', { jobId: job.id, error });
        await tx.update('deletion_jobs', job.id, {
          state: 'failed',
          last_error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
        });
      }
    }

    return { jobs: due.length, objectsPurged, failures };
  });
}

/** Objects whose retention window has passed, independent of a job row. */
export async function purgeExpiredObjects(
  store: Store,
  options: { limit?: number; nowMs?: number } = {},
): Promise<{ purged: number }> {
  const now = options.nowMs ?? Date.now();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  return store.transaction(SERVICE_SCOPE, async (tx) => {
    const expired = await tx.find('objects', {
      equals: { state: 'trashed' },
      isNotNull: ['purge_after_ms'],
      lessThanOrEqual: { column: 'purge_after_ms', value: now },
      limit,
    });
    let purged = 0;
    for (const object of expired) {
      const result = await purgeObjectEverywhere(tx, object);
      if (result.failed.length === 0) purged += 1;
    }
    return { purged };
  });
}
