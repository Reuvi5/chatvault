/**
 * The import lifecycle (plan §3, §8, §10).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiRequestError, bytesImportSource, previewImport, runImport } from '@chatvault/client';
import { buildSyntheticExport } from '@chatvault/parser';
import { createLocalFetch } from '@/server/localRouter';
import {
  cleanupDataDir,
  createAccount,
  getStore,
  importFixture,
  readerFor,
  type TestAccount,
} from './harness';

let account: TestAccount;

beforeAll(async () => {
  account = await createAccount();
}, 120_000);

afterAll(async () => {
  await cleanupDataDir();
});

describe('a first import', () => {
  it('stores pages, media and a manifest, and nothing is left pending', async () => {
    const { outcome } = await importFixture(account, { messageCount: 20, seed: 1 });
    const store = await getStore();
    const objects = await store.find('objects', {
      equals: { import_id: outcome.importId },
    });

    expect(objects.length).toBe(outcome.uploadedObjects);
    expect(objects.every((object) => object.state === 'primary_stored')).toBe(true);
    expect(objects.filter((object) => object.kind === 'manifest')).toHaveLength(1);
    expect(objects.filter((object) => object.kind === 'page').length).toBeGreaterThanOrEqual(1);
    expect(objects.filter((object) => object.kind === 'media').length).toBeGreaterThan(0);

    const conversation = await store.get('conversations', outcome.conversationId);
    expect(conversation?.manifest_version).toBe(1);
    expect(conversation?.manifest_object_id).toBeTruthy();
    expect(conversation?.logical_bytes).toBe(
      objects.reduce((sum, object) => sum + object.ciphertext_bytes, 0),
    );
  });

  it('reads back exactly what went in', async () => {
    const fixture = buildSyntheticExport({ platform: 'ios', withMedia: true, messageCount: 25, seed: 2 });
    const source = bytesImportSource(fixture.fileName, fixture.bytes);
    const preview = await previewImport({ source });
    const outcome = await runImport({
      api: account.api,
      vault: account.vault,
      source,
      preview,
      assumedTimeZone: 'UTC',
    });

    const reader = await readerFor(account);
    const manifest = await reader.loadManifest(
      (await account.api.conversations()).conversations.find(
        (candidate) => candidate.id === outcome.conversationId,
      )?.manifestObjectId as string,
    );
    const messages = await reader.loadMessages(manifest);

    expect(messages).toHaveLength(preview.parsed.counts.total);
    expect(messages.map((message) => message.body)).toEqual(
      preview.parsed.messages.map((message) => message.body),
    );

    const attachment = manifest.attachments.find((item) => !item.missing);
    expect(attachment).toBeDefined();
    const loaded = await reader.loadAttachment(attachment as never);
    expect(loaded.bytes.byteLength).toBe(attachment?.byteLength);
  });
});

describe('re-importing', () => {
  it('adds nothing and re-uploads nothing but the manifest when the export is identical', async () => {
    const fixture = buildSyntheticExport({ platform: 'android', withMedia: true, messageCount: 18, seed: 3 });
    const source = bytesImportSource(fixture.fileName, fixture.bytes);
    const preview = await previewImport({ source });

    const first = await runImport({
      api: account.api,
      vault: account.vault,
      source,
      preview,
      assumedTimeZone: 'UTC',
    });

    const reader = await readerFor(account);
    const existing = await reader.loadMessages(first.manifest);

    const second = await runImport({
      api: account.api,
      vault: account.vault,
      source,
      preview,
      assumedTimeZone: 'UTC',
      conversationId: first.conversationId,
      existingManifest: first.manifest,
      existingMessages: existing,
    });

    expect(second.merge.added).toBe(0);
    expect(second.merge.duplicatesSkipped).toBe(preview.parsed.counts.total);
    // Only the manifest is new; every page and attachment object is reused.
    expect(second.uploadedObjects).toBe(1);
    expect(second.reusedObjects).toBe(first.uploadedObjects - 1);
    expect(second.manifest.manifestVersion).toBe(2);
  });

  it('appends new messages and moves the superseded page to the trash', async () => {
    const day1 = buildSyntheticExport({
      platform: 'android',
      withMedia: false,
      messageCount: 10,
      seed: 7,
      startDate: { year: 2026, month: 1, day: 5 },
    });
    const sourceA = bytesImportSource(day1.fileName, day1.bytes);
    const previewA = await previewImport({ source: sourceA });
    const first = await runImport({
      api: account.api,
      vault: account.vault,
      source: sourceA,
      preview: previewA,
      assumedTimeZone: 'UTC',
    });

    // The same conversation, exported again later with more messages.
    const extendedTranscript = `${day1.transcript}20/01/2026, 09:10 - Dana Okonkwo: one more thing\n20/01/2026, 09:11 - Sam Reyes: noted\n`;
    const sourceB = bytesImportSource(day1.fileName, new TextEncoder().encode(extendedTranscript));
    const previewB = await previewImport({ source: sourceB });

    const reader = await readerFor(account);
    const existing = await reader.loadMessages(first.manifest);

    const second = await runImport({
      api: account.api,
      vault: account.vault,
      source: sourceB,
      preview: previewB,
      assumedTimeZone: 'UTC',
      conversationId: first.conversationId,
      existingManifest: first.manifest,
      existingMessages: existing,
    });

    expect(second.merge.added).toBe(2);
    expect(second.manifest.messageCount).toBe(first.manifest.messageCount + 2);

    const store = await getStore();
    const oldPageId = first.manifest.pages[0]?.objectId as string;
    const oldPage = await store.get('objects', oldPageId);
    expect(oldPage?.state).toBe('trashed');
    expect(oldPage?.purge_after_ms).toBeGreaterThan(Date.now());

    // The conversation's billed size only counts live objects.
    const conversation = await store.get('conversations', first.conversationId);
    const live = await store.find('objects', {
      equals: { conversation_id: first.conversationId },
      in: { column: 'state', values: ['primary_stored', 'verified'] },
    });
    expect(conversation?.logical_bytes).toBe(
      live.reduce((sum, object) => sum + object.ciphertext_bytes, 0),
    );

    const restored = await reader.loadMessages(second.manifest);
    expect(restored.at(-1)?.body).toBe('noted');
  });

  it('refuses a manifest version that is not the next one', async () => {
    const { outcome } = await importFixture(account, { messageCount: 8, seed: 11 });
    const second = await account.api.createImport({
      conversationId: outcome.conversationId,
      plannedCiphertextBytes: 100,
      plannedObjectCount: 1,
      parserVersion: 1,
      cryptoVersion: 1,
    });
    await expect(
      account.api.completeImport(second.importId, {
        manifestObjectId: outcome.manifest.pages[0]?.objectId as string,
        manifestVersion: 9,
        objectIds: [],
        supersededObjectIds: [],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('what the server refuses to accept', () => {
  it('rejects an object whose checksum does not match what was stored', async () => {
    const created = await account.api.createImport({
      plannedCiphertextBytes: 1024,
      plannedObjectCount: 1,
      parserVersion: 1,
      cryptoVersion: 1,
    });
    const authorization = await account.api.authorizeUpload({
      importId: created.importId,
      kind: 'page',
      expectedCiphertextBytes: 64,
    });
    await account.api.uploadPart(
      authorization.uploadUrlTemplate,
      1,
      authorization.ticket,
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    );

    await expect(
      account.api.completeObject({
        ticket: authorization.ticket,
        ciphertextBytes: 8,
        ciphertextSha256: '0'.repeat(64),
        parts: [{ part: 1, bytes: 8 }],
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });

    // The rejected object leaves nothing behind.
    const store = await getStore();
    expect(await store.get('objects', authorization.objectId)).toBeNull();
    expect(await store.get('upload_sessions', authorization.objectId)).toBeNull();
  });

  it('rejects a claimed size that does not match the bytes received', async () => {
    const created = await account.api.createImport({
      plannedCiphertextBytes: 1024,
      plannedObjectCount: 1,
      parserVersion: 1,
      cryptoVersion: 1,
    });
    const authorization = await account.api.authorizeUpload({
      importId: created.importId,
      kind: 'page',
      expectedCiphertextBytes: 64,
    });
    await account.api.uploadPart(
      authorization.uploadUrlTemplate,
      1,
      authorization.ticket,
      new Uint8Array(16),
    );
    await expect(
      account.api.completeObject({
        ticket: authorization.ticket,
        ciphertextBytes: 999,
        ciphertextSha256: 'a'.repeat(64),
        parts: [{ part: 1, bytes: 16 }],
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('drops objects that were authorized but never finished', async () => {
    const { outcome } = await importFixture(account, { messageCount: 6, seed: 13 });
    const store = await getStore();

    const next = await account.api.createImport({
      conversationId: outcome.conversationId,
      plannedCiphertextBytes: 500,
      plannedObjectCount: 2,
      parserVersion: 1,
      cryptoVersion: 1,
    });
    const abandoned = await account.api.authorizeUpload({
      importId: next.importId,
      kind: 'media',
      expectedCiphertextBytes: 100,
    });
    expect(await store.get('objects', abandoned.objectId)).not.toBeNull();

    // Complete the import without that object: it must be discarded, and the
    // conversation must not be left referencing a half-uploaded object.
    const manifestUpload = await account.api.authorizeUpload({
      importId: next.importId,
      kind: 'manifest',
      expectedCiphertextBytes: 200,
    });
    const { encryptJsonObject, deriveSubkey } = await import('@chatvault/crypto');
    const encoded = await encryptJsonObject({
      material: await deriveSubkey(account.vault.key, 'manifests'),
      objectId: manifestUpload.objectId,
      kind: 'manifest',
      value: { ...outcome.manifest, manifestVersion: 2 },
    });
    await account.api.uploadPart(
      manifestUpload.uploadUrlTemplate,
      1,
      manifestUpload.ticket,
      encoded.bytes,
    );
    await account.api.completeObject({
      ticket: manifestUpload.ticket,
      ciphertextBytes: encoded.stats.ciphertextBytes,
      ciphertextSha256: encoded.stats.ciphertextSha256,
      parts: [{ part: 1, bytes: encoded.bytes.byteLength }],
    });

    const status = await account.api.completeImport(next.importId, {
      manifestObjectId: manifestUpload.objectId,
      manifestVersion: 2,
      objectIds: [manifestUpload.objectId],
      supersededObjectIds: [],
    });

    expect(status.state).toBe('primary_stored');
    expect(await store.get('objects', abandoned.objectId)).toBeNull();
  });

  it('treats a repeated request with the same idempotency key as one request', async () => {
    const localFetch = createLocalFetch({ jar: account.jar });
    const body = JSON.stringify({
      plannedCiphertextBytes: 10,
      plannedObjectCount: 1,
      parserVersion: 1,
      cryptoVersion: 1,
    });
    const call = () =>
      localFetch('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'key-123' },
        body,
      }).then((response) => response.json() as Promise<{ importId: string }>);

    const first = await call();
    const second = await call();
    expect(second.importId).toBe(first.importId);

    const conflicting = await localFetch('/api/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-123' },
      body: JSON.stringify({
        plannedCiphertextBytes: 99,
        plannedObjectCount: 1,
        parserVersion: 1,
        cryptoVersion: 1,
      }),
    });
    expect(conflicting.status).toBe(409);
  });

  it('refuses an import that would exceed the account quota', async () => {
    const store = await getStore();
    const usage = await account.api.usage();
    await store.update('accounts', account.accountId, {
      quota_bytes: usage.currentLogicalBytes + 10,
    });
    try {
      const created = await account.api.createImport({
        plannedCiphertextBytes: 1_000_000,
        plannedObjectCount: 1,
        parserVersion: 1,
        cryptoVersion: 1,
      });
      await expect(
        account.api.authorizeUpload({
          importId: created.importId,
          kind: 'page',
          expectedCiphertextBytes: 1_000_000,
        }),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
    } finally {
      await store.update('accounts', account.accountId, { quota_bytes: 2_000_000_000_000 });
    }
  });

  it('reports a readable error for a file that is not an export', async () => {
    const source = bytesImportSource('notes.txt', new TextEncoder().encode('just some notes\n'));
    const preview = await previewImport({ source });
    expect(preview.parsed.messages).toHaveLength(0);
    expect(preview.warnings.some((warning) => warning.code === 'empty_transcript')).toBe(true);
  });

  it('refuses an archive with no transcript in it', async () => {
    const { zipSync } = await import('fflate');
    const archive = zipSync({ 'photo.png': new Uint8Array([1, 2, 3]) });
    await expect(
      previewImport({ source: bytesImportSource('photos.zip', archive) }),
    ).rejects.toThrow(/does not contain a chat transcript/i);
  });
});

describe('error envelopes', () => {
  it('always uses one shape, with a machine-readable code', async () => {
    try {
      await account.api.importStatus('imp_doesnotexist0000000000');
      throw new Error('should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      const typed = error as ApiRequestError;
      expect([400, 404]).toContain(typed.status);
      expect(['bad_request', 'not_found']).toContain(typed.code);
      expect(typed.message.length).toBeGreaterThan(5);
    }
  });
});
