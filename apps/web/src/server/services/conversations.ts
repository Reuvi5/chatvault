/**
 * Listing conversations.
 *
 * The response carries no titles and no participants: those live in the
 * encrypted manifest, which the client fetches and decrypts itself. What the
 * server can say is which conversations exist, how big they are, and whether
 * both copies have been verified.
 */
import type { ConversationSummary } from '@chatvault/protocol';
import type { RowOf, Store } from '../db/index';
import { notFound } from '../http';

function toSummary(row: RowOf<'conversations'>): ConversationSummary {
  return {
    id: row.id,
    manifestObjectId: row.manifest_object_id,
    manifestVersion: row.manifest_version,
    state: row.state as ConversationSummary['state'],
    logicalBytes: row.logical_bytes,
    objectCount: row.object_count,
    archiveVerified: row.archive_verified,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    trashedAtMs: row.trashed_at_ms,
  };
}

export async function listConversations(
  store: Store,
  accountId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<ConversationSummary[]> {
  const rows = await store.find('conversations', {
    equals: { account_id: accountId },
    orderBy: { column: 'updated_at_ms', direction: 'desc' },
    limit: 10_000,
  });
  return rows
    .filter((row) => (options.includeTrashed ? row.state !== 'purged' : row.state === 'active'))
    .map(toSummary);
}

export async function getConversation(
  store: Store,
  accountId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const row = await store.get('conversations', conversationId);
  if (!row || row.account_id !== accountId) throw notFound('That conversation does not exist.');
  return toSummary(row);
}
