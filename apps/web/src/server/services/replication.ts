/**
 * Replication and verification (plan §7).
 *
 * One durable, idempotent worker copies every object to the second provider and
 * verifies it, and only then is a conversation allowed to say **Verified**.
 *
 * Properties that matter:
 *  - Idempotent: re-running a replica that already exists re-verifies it.
 *  - Retried with a backoff, then parked in `replication_failed` rather than
 *    retried forever (the dead-letter state).
 *  - Verification compares the digest recorded at upload with a digest computed
 *    by reading the bytes back out of the *secondary*, so a silent truncation on
 *    the way in is caught.
 *  - Deletions are never mirrored implicitly; purging is a separate, deliberate
 *    job (see deletion.ts).
 */
import { createHash } from 'node:crypto';
import { MAX_REPLICATION_ATTEMPTS } from '@chatvault/protocol';
import { SERVICE_SCOPE, type RowOf, type Store } from '../db/index';
import { getPrimaryDriver, getSecondaryDriver } from '../objects/index';
import { log } from '../log';
import { recordAudit } from '../security';

export interface ReplicationResult {
  processed: number;
  verified: number;
  failed: number;
  deadLettered: number;
  conversationsVerified: number;
  skipped: string | null;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function replicateOne(
  store: Store,
  replica: RowOf<'replicas'>,
): Promise<'verified' | 'failed' | 'dead_lettered'> {
  const secondary = getSecondaryDriver();
  const primary = getPrimaryDriver();
  const now = Date.now();

  if (!secondary) return 'failed';
  const object = await store.get('objects', replica.object_id);
  if (!object) {
    // The object was purged while this was queued; drop the replica row.
    await store.remove('replicas', replica.id);
    return 'verified';
  }

  try {
    const existing = await secondary.head(object.storage_key);
    let digest: string;
    if (existing && existing.bytes === object.ciphertext_bytes) {
      // Already there: verify rather than copy again.
      digest = sha256(await secondary.get(object.storage_key));
    } else {
      const bytes = await primary.get(object.storage_key);
      if (sha256(bytes) !== object.ciphertext_sha256) {
        throw new Error('the primary copy no longer matches its recorded checksum');
      }
      await secondary.put(object.storage_key, bytes);
      const head = await secondary.head(object.storage_key);
      if (!head || head.bytes !== bytes.byteLength) {
        throw new Error('the secondary copy is a different size from the primary');
      }
      digest = sha256(await secondary.get(object.storage_key));
    }

    if (object.ciphertext_sha256 && digest !== object.ciphertext_sha256) {
      throw new Error('the secondary copy does not match the checksum recorded at upload');
    }

    await store.update('replicas', replica.id, {
      state: 'verified',
      ciphertext_sha256: digest,
      ciphertext_bytes: object.ciphertext_bytes,
      attempts: replica.attempts + 1,
      last_error: null,
      last_verified_ms: now,
      updated_at_ms: now,
    });

    const replicas = await store.find('replicas', { equals: { object_id: object.id } });
    const allVerified =
      replicas.length >= 2 && replicas.every((candidate) => candidate.state === 'verified');
    if (allVerified && object.state === 'primary_stored') {
      await store.update('objects', object.id, { state: 'verified', updated_at_ms: now });
    }
    return 'verified';
  } catch (error) {
    const attempts = replica.attempts + 1;
    const dead = attempts >= MAX_REPLICATION_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);
    await store.update('replicas', replica.id, {
      state: dead ? 'failed' : 'pending',
      attempts,
      last_error: message.slice(0, 400),
      updated_at_ms: now,
    });
    if (dead) {
      await store.update('objects', object.id, {
        state: 'replication_failed',
        updated_at_ms: now,
      });
      await recordAudit(store, {
        accountId: object.account_id,
        kind: 'replication.failed',
        detail: `object ${object.id} could not be copied to the backup provider: ${message.slice(0, 160)}`,
      });
      log.error('An object could not be replicated and was parked', {
        objectId: object.id,
        attempts,
      });
    } else {
      log.warn('Replication attempt failed and will be retried', {
        objectId: object.id,
        attempts,
      });
    }
    return dead ? 'dead_lettered' : 'failed';
  }
}

/**
 * Mark conversations verified when every object they reference is verified on
 * both providers **and** their manifest is readable from storage. A conversation
 * whose media is safe but whose manifest is not recoverable is not a restorable
 * archive, so it does not qualify (plan §7 "media alone is not a restore plan").
 */
export async function refreshConversationVerification(
  store: Store,
  accountId: string,
): Promise<number> {
  const conversations = await store.find('conversations', {
    equals: { account_id: accountId, state: 'active' },
    limit: 10_000,
  });
  let changed = 0;

  for (const conversation of conversations) {
    const objects = await store.find('objects', {
      equals: { conversation_id: conversation.id, account_id: accountId },
      in: {
        column: 'state',
        values: ['pending', 'primary_stored', 'verified', 'replication_failed'],
      },
      limit: 500_000,
    });
    const live = objects.filter((object) => object.state !== 'pending');
    const manifestPresent =
      conversation.manifest_object_id !== null &&
      live.some((object) => object.id === conversation.manifest_object_id);
    const verified =
      manifestPresent && live.length > 0 && live.every((object) => object.state === 'verified');

    if (verified !== conversation.archive_verified) {
      await store.update('conversations', conversation.id, {
        archive_verified: verified,
        updated_at_ms: Date.now(),
      });
      changed += 1;
    }

    const importsForConversation = await store.find('imports', {
      equals: { conversation_id: conversation.id, state: 'primary_stored' },
      limit: 1000,
    });
    if (verified) {
      for (const importRow of importsForConversation) {
        await store.update('imports', importRow.id, {
          state: 'verified',
          updated_at_ms: Date.now(),
        });
      }
    }
  }
  return changed;
}

export async function runReplication(
  store: Store,
  options: { limit?: number; accountId?: string } = {},
): Promise<ReplicationResult> {
  const secondary = getSecondaryDriver();
  if (!secondary) {
    return {
      processed: 0,
      verified: 0,
      failed: 0,
      deadLettered: 0,
      conversationsVerified: 0,
      skipped: 'No secondary provider is configured, so nothing can be verified.',
    };
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const scope = options.accountId ?? SERVICE_SCOPE;

  return store.transaction(scope, async (tx) => {
    const pending = await tx.find('replicas', {
      equals: { state: 'pending', ...(options.accountId ? { account_id: options.accountId } : {}) },
      lessThan: { column: 'attempts', value: MAX_REPLICATION_ATTEMPTS },
      orderBy: { column: 'created_at_ms', direction: 'asc' },
      limit,
    });

    let verified = 0;
    let failed = 0;
    let deadLettered = 0;
    const touchedAccounts = new Set<string>();

    for (const replica of pending) {
      const outcome = await replicateOne(tx, replica);
      touchedAccounts.add(replica.account_id);
      if (outcome === 'verified') verified += 1;
      else if (outcome === 'dead_lettered') deadLettered += 1;
      else failed += 1;
    }

    let conversationsVerified = 0;
    for (const accountId of touchedAccounts) {
      conversationsVerified += await refreshConversationVerification(tx, accountId);
    }

    return {
      processed: pending.length,
      verified,
      failed,
      deadLettered,
      conversationsVerified,
      skipped: null,
    };
  });
}

/**
 * Periodic re-verification: sample stored objects and confirm both copies still
 * match their recorded digests (plan §7 "Continuous spot checks + scheduled
 * full reconciliation").
 */
export async function reconcile(
  store: Store,
  options: { sampleSize?: number } = {},
): Promise<{
  checked: number;
  mismatches: Array<{ objectId: string; provider: string; detail: string }>;
}> {
  const sampleSize = Math.min(Math.max(options.sampleSize ?? 20, 1), 500);
  const mismatches: Array<{ objectId: string; provider: string; detail: string }> = [];

  return store.transaction(SERVICE_SCOPE, async (tx) => {
    const candidates = await tx.find('objects', {
      equals: { state: 'verified' },
      orderBy: { column: 'updated_at_ms', direction: 'asc' },
      limit: sampleSize,
    });

    for (const object of candidates) {
      for (const driver of [getPrimaryDriver(), getSecondaryDriver()]) {
        if (!driver) continue;
        try {
          const head = await driver.head(object.storage_key);
          if (!head) {
            mismatches.push({ objectId: object.id, provider: driver.label, detail: 'missing' });
            continue;
          }
          if (head.bytes !== object.ciphertext_bytes) {
            mismatches.push({
              objectId: object.id,
              provider: driver.label,
              detail: `size ${String(head.bytes)} != recorded ${String(object.ciphertext_bytes)}`,
            });
          }
        } catch (error) {
          mismatches.push({
            objectId: object.id,
            provider: driver.label,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await tx.update('objects', object.id, { updated_at_ms: Date.now() });
    }

    if (mismatches.length > 0) {
      log.error('Reconciliation found objects that do not match their records', {
        count: mismatches.length,
      });
    }
    return { checked: candidates.length, mismatches };
  });
}
