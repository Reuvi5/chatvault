/**
 * Tenant isolation (plan §11 milestone 4: "two test users cannot read each
 * other's encrypted objects or metadata").
 *
 * These are the tests that matter most: a mistake here is not a bug, it is a
 * breach. Every one of them drives the real route handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiRequestError } from '@chatvault/client';
import { cleanupDataDir, createAccount, importFixture, newClient, type TestAccount } from './harness';

let alice: TestAccount;
let bob: TestAccount;
let aliceConversationId: string;
let aliceObjectIds: string[];
let aliceImportId: string;

beforeAll(async () => {
  alice = await createAccount();
  bob = await createAccount();
  const imported = await importFixture(alice, { messageCount: 12 });
  aliceConversationId = imported.outcome.conversationId;
  aliceImportId = imported.outcome.importId;
  aliceObjectIds = [
    ...imported.outcome.manifest.pages.map((page) => page.objectId),
    ...imported.outcome.manifest.attachments
      .map((item) => item.objectId)
      .filter((id): id is string => id !== null),
  ];
  expect(aliceObjectIds.length).toBeGreaterThan(1);
}, 120_000);

afterAll(async () => {
  await cleanupDataDir();
});

async function expectDenied(action: () => Promise<unknown>, codes: string[] = ['not_found', 'forbidden']) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(codes).toContain((error as ApiRequestError).code);
    return;
  }
  throw new Error('That request should have been refused.');
}

describe('one account cannot reach another account', () => {
  it('does not list the other account conversations', async () => {
    const mine = await bob.api.conversations();
    expect(mine.conversations).toHaveLength(0);
    const theirs = await alice.api.conversations();
    expect(theirs.conversations).toHaveLength(1);
  });

  it('cannot authorize a download of another account object', async () => {
    for (const objectId of aliceObjectIds.slice(0, 3)) {
      await expectDenied(() => bob.api.authorizeDownload(objectId));
    }
  });

  it('cannot fetch another account ciphertext even with a valid session', async () => {
    const objectId = aliceObjectIds[0] as string;
    await expectDenied(() => bob.api.downloadObject(objectId));
  });

  it('cannot reuse a ticket issued to another account', async () => {
    const objectId = aliceObjectIds[0] as string;
    const authorization = await alice.api.authorizeDownload(objectId);

    // Bob presents Alice's ticket on his own session.
    const response = await fetchAs(bob, authorization.downloadUrl, authorization.ticket);
    expect(response.status).toBeGreaterThanOrEqual(400);

    // And the ticket is refused for a different object on Alice's own session.
    const otherObject = aliceObjectIds[1] as string;
    const crossObject = await fetchAs(
      alice,
      `/api/objects/${otherObject}/content`,
      authorization.ticket,
    );
    expect(crossObject.status).toBe(403);
  });

  it('cannot complete, read or add to another account import', async () => {
    await expectDenied(() => bob.api.importStatus(aliceImportId));
    await expectDenied(() =>
      bob.api.completeImport(aliceImportId, {
        manifestObjectId: aliceObjectIds[0] as string,
        manifestVersion: 2,
        objectIds: [],
        supersededObjectIds: [],
      }),
    );
    await expectDenied(() =>
      bob.api.authorizeUpload({ importId: aliceImportId, kind: 'page', expectedCiphertextBytes: 10 }),
    );
  });

  it('cannot trash, restore or purge another account conversation', async () => {
    await expectDenied(() => bob.api.deleteConversation(aliceConversationId, 'trash'));
    await expectDenied(() => bob.api.restoreConversation(aliceConversationId));
    await expectDenied(() => bob.api.deleteConversation(aliceConversationId, 'purge', 'DELETE'));
    // Alice's conversation is untouched.
    const theirs = await alice.api.conversations();
    expect(theirs.conversations[0]?.state).toBe('active');
  });

  it('cannot see another account usage', async () => {
    const bobUsage = await bob.api.usage();
    expect(bobUsage.currentLogicalBytes).toBe(0);
    const aliceUsage = await alice.api.usage();
    expect(aliceUsage.currentLogicalBytes).toBeGreaterThan(0);
  });

  it('cannot replicate or inspect operations for another account', async () => {
    const before = await alice.api.operationsStatus();
    const result = await bob.api.runReplication(100);
    expect(result.processed).toBe(0);
    const bobStatus = await bob.api.operationsStatus();
    expect(bobStatus.objects.verified ?? 0).toBe(0);
    expect(before.objects.pending ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe('sessions', () => {
  it('refuses everything without a session', async () => {
    const { api } = newClient('10.0.0.9');
    expect(await api.session()).toBeNull();
    await expectDenied(() => api.conversations(), ['unauthorized']);
    await expectDenied(() => api.usage(), ['unauthorized']);
    await expectDenied(
      () => api.createImport({ plannedCiphertextBytes: 1, plannedObjectCount: 1, parserVersion: 1, cryptoVersion: 1 }),
      ['unauthorized'],
    );
  });

  it('refuses a forged session cookie', async () => {
    const { api, jar } = newClient('10.0.0.10');
    jar.absorb(
      new Response(null, { headers: { 'set-cookie': 'cv_session=not-a-real-token; Path=/' } }),
    );
    expect(await api.session()).toBeNull();
  });

  it('stops working after signing out', async () => {
    const account = await createAccount();
    expect(await account.api.session()).not.toBeNull();
    await account.api.logout();
    expect(await account.api.session()).toBeNull();
  });

  it('refuses importing before the email address is confirmed', async () => {
    const unverified = await createAccount({ verify: false });
    await expectDenied(
      () =>
        unverified.api.createImport({
          plannedCiphertextBytes: 10,
          plannedObjectCount: 1,
          parserVersion: 1,
          cryptoVersion: 1,
        }),
      ['unauthorized'],
    );
  });
});

/** Issue a raw request as a given account, with an arbitrary ticket. */
async function fetchAs(account: TestAccount, path: string, ticket: string): Promise<Response> {
  const { createLocalFetch } = await import('@/server/localRouter');
  const localFetch = createLocalFetch({ jar: account.jar });
  return localFetch(path, {
    method: 'GET',
    headers: { 'x-chatvault-ticket': ticket },
  });
}
