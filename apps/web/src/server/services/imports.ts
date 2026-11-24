/**
 * The import lifecycle.
 *
 * An import is only "the current state of a conversation" once its manifest has
 * been stored and checked, and it is only shown as **Archive Verified** once
 * every object it needs exists and has been verified on both independent
 * providers (plan §3.8, §7).
 */
import {
  newId,
  type CompleteImportRequest,
  type CreateImportRequest,
  type CreateImportResponse,
  type ImportStatusResponse,
} from '@chatvault/protocol';
import type { RowOf, Store } from '../db/index';
import { badRequest, conflict, notFound } from '../http';
import { recordAudit } from '../security';
import { measureUsage, recordUsageSnapshot, trashRetentionMs } from './metering';
import { BILLABLE_OBJECT_STATES } from './metering';

export async function createImport(
  store: Store,
  account: RowOf<'accounts'>,
  vault: RowOf<'vaults'>,
  input: CreateImportRequest,
): Promise<CreateImportResponse> {
  const now = Date.now();
  let conversationId = input.conversationId ?? null;

  if (conversationId) {
    const conversation = await store.get('conversations', conversationId);
    if (!conversation || conversation.account_id !== account.id) {
      throw notFound('That conversation does not exist.');
    }
    if (conversation.state !== 'active') {
      throw conflict('That conversation is in the trash. Restore it before importing into it.');
    }
  } else {
    conversationId = newId('cnv');
    await store.insert('conversations', {
      id: conversationId,
      account_id: account.id,
      vault_id: vault.id,
      manifest_object_id: null,
      manifest_version: 0,
      state: 'active',
      logical_bytes: 0,
      object_count: 0,
      archive_verified: false,
      created_at_ms: now,
      updated_at_ms: now,
      trashed_at_ms: null,
      purge_after_ms: null,
    });
  }

  const importId = newId('imp');
  await store.insert('imports', {
    id: importId,
    account_id: account.id,
    vault_id: vault.id,
    conversation_id: conversationId,
    state: 'open',
    parser_version: input.parserVersion,
    crypto_version: input.cryptoVersion,
    planned_objects: input.plannedObjectCount,
    planned_bytes: input.plannedCiphertextBytes,
    object_count: 0,
    ciphertext_bytes: 0,
    manifest_object_id: null,
    manifest_version: 0,
    last_error: null,
    created_at_ms: now,
    updated_at_ms: now,
    completed_at_ms: null,
  });

  await recordAudit(store, {
    accountId: account.id,
    kind: 'import.created',
    detail: `import ${importId} for conversation ${conversationId}`,
  });

  const usage = await measureUsage(store, account.id);
  return {
    importId,
    conversationId,
    quota: { allowedBytes: account.quota_bytes, usedBytes: usage.logicalBytes },
  };
}

export async function completeImport(
  store: Store,
  account: RowOf<'accounts'>,
  importId: string,
  input: CompleteImportRequest,
): Promise<ImportStatusResponse> {
  const importRow = await store.get('imports', importId);
  if (!importRow || importRow.account_id !== account.id)
    throw notFound('That import does not exist.');
  if (importRow.state === 'verified' || importRow.state === 'primary_stored') {
    return buildImportStatus(store, importRow);
  }
  if (importRow.state !== 'uploading' && importRow.state !== 'open') {
    throw conflict('That import can no longer be completed.');
  }

  const conversation = await store.get('conversations', importRow.conversation_id);
  if (!conversation) throw notFound('That conversation does not exist.');

  if (input.manifestVersion !== conversation.manifest_version + 1) {
    throw conflict(
      'Someone else changed this conversation while this import was running. Reload and import again.',
      { expected: conversation.manifest_version + 1, received: input.manifestVersion },
    );
  }

  /* Every object this import claims must exist, belong to this import, and be
     stored. Anything else means a partial upload, which must not become the
     current state of the conversation. */
  const uploaded = await store.find('objects', {
    equals: { import_id: importRow.id, account_id: account.id },
    limit: 500_000,
  });
  const byId = new Map(uploaded.map((object) => [object.id, object]));

  for (const objectId of input.objectIds) {
    const object = byId.get(objectId);
    if (!object) {
      throw badRequest(`Object ${objectId} was not uploaded as part of this import.`);
    }
    if (!BILLABLE_OBJECT_STATES.includes(object.state as (typeof BILLABLE_OBJECT_STATES)[number])) {
      throw conflict(`Object ${objectId} did not finish uploading.`);
    }
  }

  const manifestObject = byId.get(input.manifestObjectId);
  if (!manifestObject || manifestObject.kind !== 'manifest') {
    throw badRequest('The manifest object is missing from this import.');
  }

  const pending = uploaded.filter((object) => object.state === 'pending');
  for (const object of pending) {
    // Abandoned authorizations: remove the rows, nothing was stored.
    await store.remove('upload_sessions', object.id).catch(() => undefined);
    await store.remove('objects', object.id);
  }

  /* Supersede what this import replaced. Objects move to the trash with a
     retention window; nothing is erased inline (plan §7). */
  const now = Date.now();
  const purgeAfter = now + trashRetentionMs();
  let superseded = 0;
  for (const objectId of input.supersededObjectIds) {
    const object = await store.get('objects', objectId);
    if (!object || object.account_id !== account.id) continue;
    if (object.conversation_id !== conversation.id) continue;
    if (input.objectIds.includes(objectId)) continue;
    await store.update('objects', objectId, {
      state: 'trashed',
      trashed_at_ms: now,
      purge_after_ms: purgeAfter,
      updated_at_ms: now,
    });
    superseded += 1;
  }

  const logicalBytes = await store.sum('objects', 'ciphertext_bytes', {
    equals: { conversation_id: conversation.id, account_id: account.id },
    in: { column: 'state', values: [...BILLABLE_OBJECT_STATES] },
  });
  const objectCount = await store.count('objects', {
    equals: { conversation_id: conversation.id, account_id: account.id },
    in: { column: 'state', values: [...BILLABLE_OBJECT_STATES] },
  });

  await store.update('conversations', conversation.id, {
    manifest_object_id: input.manifestObjectId,
    manifest_version: input.manifestVersion,
    logical_bytes: logicalBytes,
    object_count: objectCount,
    archive_verified: false,
    updated_at_ms: now,
  });

  await store.update('imports', importRow.id, {
    state: 'primary_stored',
    manifest_object_id: input.manifestObjectId,
    manifest_version: input.manifestVersion,
    updated_at_ms: now,
    completed_at_ms: now,
  });

  await recordUsageSnapshot(store, account.id, 'import');
  await recordAudit(store, {
    accountId: account.id,
    kind: 'import.completed',
    detail: `import ${importRow.id}: ${String(input.objectIds.length)} objects, ${String(superseded)} superseded`,
  });

  const refreshed = await store.get('imports', importRow.id);
  return buildImportStatus(store, refreshed ?? importRow);
}

export async function buildImportStatus(
  store: Store,
  importRow: RowOf<'imports'>,
): Promise<ImportStatusResponse> {
  const objects = await store.find('objects', {
    equals: { import_id: importRow.id },
    limit: 500_000,
  });
  const counts = {
    total: objects.length,
    pending: objects.filter((object) => object.state === 'pending').length,
    primaryStored: objects.filter((object) => object.state === 'primary_stored').length,
    verified: objects.filter((object) => object.state === 'verified').length,
    failed: objects.filter((object) => object.state === 'replication_failed').length,
  };

  const conversation = await store.get('conversations', importRow.conversation_id);

  return {
    importId: importRow.id,
    conversationId: importRow.conversation_id,
    state: importRow.state as ImportStatusResponse['state'],
    objects: counts,
    logicalBytes: importRow.ciphertext_bytes,
    archiveVerified: conversation?.archive_verified ?? false,
    lastError: importRow.last_error,
    updatedAtMs: importRow.updated_at_ms,
  };
}

export async function failImport(
  store: Store,
  importRow: RowOf<'imports'>,
  reason: string,
): Promise<void> {
  await store.update('imports', importRow.id, {
    state: 'failed',
    last_error: reason.slice(0, 400),
    updated_at_ms: Date.now(),
  });
  await recordAudit(store, {
    accountId: importRow.account_id,
    kind: 'import.failed',
    detail: `${importRow.id}: ${reason.slice(0, 200)}`,
  });
}

/**
 * Abandon imports that were authorized but never completed, so their objects do
 * not sit in storage being paid for and never read.
 */
export async function reapAbandonedImports(
  store: Store,
  olderThanMs = 24 * 60 * 60 * 1000,
): Promise<{ imports: number; objects: number }> {
  const cutoff = Date.now() - olderThanMs;
  const stale = await store.find('imports', {
    in: { column: 'state', values: ['open', 'uploading'] },
    lessThan: { column: 'updated_at_ms', value: cutoff },
    limit: 200,
  });

  let objectsRemoved = 0;
  for (const importRow of stale) {
    const objects = await store.find('objects', { equals: { import_id: importRow.id } });
    for (const object of objects) {
      await store.update('objects', object.id, {
        state: 'trashed',
        trashed_at_ms: Date.now(),
        purge_after_ms: Date.now(),
        updated_at_ms: Date.now(),
      });
      objectsRemoved += 1;
    }
    await store.update('imports', importRow.id, {
      state: 'abandoned',
      last_error: 'The import was never completed.',
      updated_at_ms: Date.now(),
    });
  }
  return { imports: stale.length, objects: objectsRemoved };
}
