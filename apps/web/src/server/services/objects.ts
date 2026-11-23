/**
 * The object lifecycle: authorize, receive parts, verify, record.
 *
 * The server's job is to store opaque bytes and to be able to prove later that
 * the bytes it holds are the bytes it was given. So completion does a read-back:
 * the object is streamed out of the primary store and hashed, and the digest
 * must match the one the client computed while encrypting. A mismatch is
 * refused outright rather than recorded as stored (plan §7 "Verify source
 * checksums, remote checksums…").
 *
 * What the server cannot do is tell whether the plaintext is what the person
 * intended; only the AES-GCM tags on the device can.
 */
import { createHash } from 'node:crypto';
import {
  MAX_REPLICATION_ATTEMPTS,
  newId,
  objectStorageKey,
  type ObjectKind,
} from '@chatvault/protocol';
import type { RowOf, Store } from '../db/index';
import { getPrimaryDriver, getSecondaryDriver, readOrder } from '../objects/index';
import { ObjectStoreError } from '../objects/driver';
import { badRequest, conflict, forbidden, notFound, quotaExceeded } from '../http';
import { issueTicket, verifyTicket, type TicketClaims } from '../tickets';
import { recordAudit } from '../security';
import { measureUsage } from './metering';
import { log } from '../log';

export interface UploadAuthorization {
  objectId: string;
  ticket: string;
  expiresAtMs: number;
  partSizeBytes: number;
  uploadUrlTemplate: string;
  driver: 'local' | 's3';
}

export async function authorizeUpload(
  store: Store,
  account: RowOf<'accounts'>,
  input: { importId: string; kind: ObjectKind; expectedCiphertextBytes: number },
): Promise<UploadAuthorization> {
  const importRow = await store.get('imports', input.importId);
  if (!importRow || importRow.account_id !== account.id) {
    throw notFound('That import does not exist.');
  }
  if (!['open', 'uploading'].includes(importRow.state)) {
    throw conflict('That import is already finished.');
  }

  const usage = await measureUsage(store, account.id);
  const projected = usage.logicalBytes + importRow.ciphertext_bytes + input.expectedCiphertextBytes;
  if (projected > account.quota_bytes) {
    throw quotaExceeded(
      'This import would take the archive past the storage limit on this account.',
      { quotaBytes: account.quota_bytes, currentBytes: usage.logicalBytes },
    );
  }

  const objectId = newId('obj');
  const storageKey = objectStorageKey(account.id, objectId);
  const driver = getPrimaryDriver();
  const { uploadId } = await driver.beginUpload(storageKey);
  const now = Date.now();

  await store.insert('objects', {
    id: objectId,
    account_id: account.id,
    vault_id: importRow.vault_id,
    conversation_id: importRow.conversation_id,
    import_id: importRow.id,
    kind: input.kind,
    state: 'pending',
    storage_key: storageKey,
    ciphertext_bytes: 0,
    ciphertext_sha256: null,
    part_count: 0,
    created_at_ms: now,
    updated_at_ms: now,
    trashed_at_ms: null,
    purge_after_ms: null,
  });

  await store.insert('upload_sessions', {
    id: objectId,
    account_id: account.id,
    object_id: objectId,
    provider: driver.label,
    provider_upload_id: uploadId,
    parts_json: '[]',
    created_at_ms: now,
    expires_at_ms: now + 24 * 60 * 60 * 1000,
  });

  if (importRow.state === 'open') {
    await store.update('imports', importRow.id, { state: 'uploading', updated_at_ms: now });
  }

  // A generous ceiling: the exact size is checked at completion.
  const maxBytes = Math.max(1024 * 1024, Math.ceil(input.expectedCiphertextBytes * 1.5) + 1024 * 1024);
  const { ticket, expiresAtMs } = issueTicket({
    op: 'upload',
    accountId: account.id,
    objectId,
    storageKey,
    importId: importRow.id,
    maxBytes,
  });

  return {
    objectId,
    ticket,
    expiresAtMs,
    partSizeBytes: driver.partSizeBytes,
    uploadUrlTemplate: `/api/objects/${objectId}/parts/{part}`,
    driver: driver.kind,
  };
}

interface RecordedPart {
  partNumber: number;
  etag: string | null;
  bytes: number;
}

export async function receivePart(
  store: Store,
  accountId: string,
  input: { objectId: string; partNumber: number; ticket: string | null; bytes: Uint8Array },
): Promise<{ accepted: number }> {
  const claims = verifyTicket(input.ticket, {
    op: 'upload',
    accountId,
    objectId: input.objectId,
  });
  if (input.partNumber < 1 || input.partNumber > 10_000) {
    throw badRequest('That part number is out of range.');
  }

  const session = await store.get('upload_sessions', input.objectId);
  if (!session || session.account_id !== accountId) {
    throw conflict('That upload is no longer in progress. Start it again.');
  }

  const driver = getPrimaryDriver();
  const parts = JSON.parse(session.parts_json) as RecordedPart[];
  const already = parts.reduce((sum, part) => sum + part.bytes, 0);
  const existing = parts.find((part) => part.partNumber === input.partNumber);
  const projected = already - (existing?.bytes ?? 0) + input.bytes.byteLength;
  if (claims.maxBytes !== undefined && projected > claims.maxBytes) {
    throw badRequest('This upload is larger than the size it was authorized for.');
  }

  const { etag } = await driver.uploadPart(
    claims.storageKey,
    session.provider_upload_id,
    input.partNumber,
    input.bytes,
  );

  const next = parts.filter((part) => part.partNumber !== input.partNumber);
  next.push({ partNumber: input.partNumber, etag, bytes: input.bytes.byteLength });
  next.sort((a, b) => a.partNumber - b.partNumber);
  await store.update('upload_sessions', input.objectId, { parts_json: JSON.stringify(next) });

  return { accepted: input.bytes.byteLength };
}

async function hashStoredObject(
  storageKey: string,
): Promise<{ sha256: string; bytes: number }> {
  const driver = getPrimaryDriver();
  const stream = await driver.getWebStream(storageKey);
  const hash = createHash('sha256');
  let bytes = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      hash.update(value);
      bytes += value.byteLength;
    }
  }
  return { sha256: hash.digest('hex'), bytes };
}

export interface CompletedObject {
  objectId: string;
  ciphertextBytes: number;
}

/**
 * The verdict on an upload.
 *
 * A rejection must not be thrown from inside the transaction: the cleanup it
 * performs (removing the object row and the half-written blob) has to commit.
 * So the service reports the verdict and the route handler turns a rejection
 * into a 400.
 */
export type CompleteObjectVerdict =
  | { status: 'stored'; object: CompletedObject }
  | { status: 'rejected'; reason: string };

export async function completeObject(
  store: Store,
  account: RowOf<'accounts'>,
  input: {
    ticket: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
    parts: Array<{ part: number; bytes: number }>;
    clientHash?: string;
  },
): Promise<CompleteObjectVerdict> {
  const claims = verifyTicket(input.ticket, { op: 'upload', accountId: account.id });
  const object = await store.get('objects', claims.objectId);
  if (!object || object.account_id !== account.id) throw notFound('That object does not exist.');
  if (object.state !== 'pending') {
    // Completing twice with the same ticket is harmless; report the stored facts.
    if (object.ciphertext_sha256 === input.ciphertextSha256) {
      return {
        status: 'stored',
        object: { objectId: object.id, ciphertextBytes: object.ciphertext_bytes },
      };
    }
    throw conflict('That object was already stored with different contents.');
  }

  const session = await store.get('upload_sessions', object.id);
  if (!session) throw conflict('That upload is no longer in progress. Start it again.');
  const recorded = JSON.parse(session.parts_json) as RecordedPart[];
  if (recorded.length === 0) throw badRequest('No parts were uploaded for that object.');

  const driver = getPrimaryDriver();
  const reject = async (reason: string): Promise<CompleteObjectVerdict> => {
    await driver.abortUpload(claims.storageKey, session.provider_upload_id).catch(() => undefined);
    await driver.remove(claims.storageKey).catch(() => undefined);
    await store.remove('upload_sessions', object.id);
    await store.remove('objects', object.id);
    await recordAudit(store, {
      accountId: account.id,
      kind: 'object.rejected',
      detail: reason,
      clientHash: input.clientHash ?? null,
    });
    return { status: 'rejected', reason };
  };

  await driver.completeUpload(
    claims.storageKey,
    session.provider_upload_id,
    recorded.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
  );

  const stored = await hashStoredObject(claims.storageKey);
  if (stored.bytes !== input.ciphertextBytes) {
    return reject(
      `the stored size (${String(stored.bytes)} bytes) is not the size the client reported (${String(input.ciphertextBytes)} bytes)`,
    );
  }
  if (stored.sha256 !== input.ciphertextSha256) {
    return reject('the stored bytes do not match the checksum the client computed');
  }

  const now = Date.now();
  await store.update('objects', object.id, {
    state: 'primary_stored',
    ciphertext_bytes: stored.bytes,
    ciphertext_sha256: stored.sha256,
    part_count: recorded.length,
    updated_at_ms: now,
  });
  await store.remove('upload_sessions', object.id);

  await store.insert('replicas', {
    id: newId('rep'),
    account_id: account.id,
    object_id: object.id,
    provider: driver.label,
    location: driver.location,
    state: 'verified',
    ciphertext_sha256: stored.sha256,
    ciphertext_bytes: stored.bytes,
    attempts: 1,
    last_error: null,
    last_verified_ms: now,
    created_at_ms: now,
    updated_at_ms: now,
  });

  const secondary = getSecondaryDriver();
  if (secondary) {
    await store.insert('replicas', {
      id: newId('rep'),
      account_id: account.id,
      object_id: object.id,
      provider: secondary.label,
      location: secondary.location,
      state: 'pending',
      ciphertext_sha256: null,
      ciphertext_bytes: 0,
      attempts: 0,
      last_error: null,
      last_verified_ms: null,
      created_at_ms: now,
      updated_at_ms: now,
    });
  }

  const importRow = await store.get('imports', object.import_id);
  if (importRow) {
    await store.update('imports', importRow.id, {
      object_count: importRow.object_count + 1,
      ciphertext_bytes: importRow.ciphertext_bytes + stored.bytes,
      updated_at_ms: now,
    });
  }

  return {
    status: 'stored',
    object: { objectId: object.id, ciphertextBytes: stored.bytes },
  };
}

export interface DownloadAuthorization {
  objectId: string;
  ticket: string;
  expiresAtMs: number;
  downloadUrl: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  servedBy: 'primary' | 'secondary';
}

export async function authorizeDownload(
  store: Store,
  accountId: string,
  objectId: string,
): Promise<DownloadAuthorization> {
  const object = await store.get('objects', objectId);
  if (!object || object.account_id !== accountId) throw notFound('That object does not exist.');
  if (!['primary_stored', 'verified', 'replication_failed', 'trashed'].includes(object.state)) {
    throw conflict('That object is not available yet.');
  }

  // Prefer the primary, fall back to the backup copy: a provider outage must
  // not stop someone reading their own archive (plan §7).
  let servedBy: 'primary' | 'secondary' = 'primary';
  let available = false;
  for (const candidate of readOrder()) {
    try {
      const head = await candidate.driver.head(object.storage_key);
      if (head) {
        servedBy = candidate.role;
        available = true;
        break;
      }
    } catch (error) {
      if (!(error instanceof ObjectStoreError)) throw error;
      log.warnThrottled(
        `download-head:${candidate.driver.label}`,
        'A provider could not be reached while authorizing a download',
        { provider: candidate.driver.label, role: candidate.role },
      );
    }
  }
  if (!available) {
    throw notFound('That object could not be found on either storage provider.');
  }

  const { ticket, expiresAtMs } = issueTicket({
    op: 'download',
    accountId,
    objectId: object.id,
    storageKey: object.storage_key,
  });

  return {
    objectId: object.id,
    ticket,
    expiresAtMs,
    downloadUrl: `/api/objects/${object.id}/content`,
    ciphertextBytes: object.ciphertext_bytes,
    ciphertextSha256: object.ciphertext_sha256 ?? '',
    servedBy,
  };
}

export async function openObjectStream(
  store: Store,
  accountId: string,
  objectId: string,
  ticket: string | null,
): Promise<{ stream: ReadableStream<Uint8Array>; bytes: number; servedBy: string }> {
  const claims: TicketClaims = verifyTicket(ticket, { op: 'download', accountId, objectId });
  const object = await store.get('objects', objectId);
  if (!object || object.account_id !== accountId) throw notFound('That object does not exist.');
  if (object.storage_key !== claims.storageKey) throw forbidden('That authorization does not match.');

  let lastError: unknown = null;
  for (const candidate of readOrder()) {
    try {
      const stream = await candidate.driver.getWebStream(object.storage_key);
      return { stream, bytes: object.ciphertext_bytes, servedBy: candidate.driver.label };
    } catch (error) {
      lastError = error;
    }
  }
  log.error('Neither provider could serve an object', { objectId, error: lastError });
  throw notFound('That object could not be read from either storage provider.');
}

/** Remove an object from both providers. Used by purges and by failed imports. */
export async function purgeObjectEverywhere(
  store: Store,
  object: RowOf<'objects'>,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const candidate of readOrder()) {
    try {
      await candidate.driver.remove(object.storage_key);
      removed.push(candidate.driver.label);
    } catch (error) {
      failed.push(candidate.driver.label);
      log.warn('Could not remove an object copy', {
        provider: candidate.driver.label,
        objectId: object.id,
        error,
      });
    }
  }
  if (failed.length === 0) {
    await store.removeWhere('replicas', { equals: { object_id: object.id } });
    await store.remove('objects', object.id);
  } else {
    await store.update('objects', object.id, {
      state: 'trashed',
      updated_at_ms: Date.now(),
      purge_after_ms: Date.now() + 60 * 60 * 1000,
    });
  }
  return { removed, failed };
}

export const REPLICATION_ATTEMPT_LIMIT = MAX_REPLICATION_ATTEMPTS;
