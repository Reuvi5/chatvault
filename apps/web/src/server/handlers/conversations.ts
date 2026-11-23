/**
 * Conversation and account-deletion routes.
 */
import { accountDeleteRequest, deleteConversationRequest } from '@chatvault/protocol';
import { getStore } from '../db/index';
import { badRequest, clientHash, jsonResponse, parseBody } from '../http';
import { requireSession, requireVerifiedSession } from '../auth/session';
import { enforceRateLimit } from '../security';
import { getEnv } from '../env';
import { listConversations } from '../services/conversations';
import {
  purgeConversation,
  requestAccountDeletion,
  restoreConversation,
  trashConversation,
} from '../services/deletion';

export async function handleListConversations(request: Request): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`read:${account.id}`, getEnv().rateLimits.read);
  const includeTrashed = new URL(request.url).searchParams.get('includeTrashed') === 'true';
  const store = await getStore();
  return jsonResponse({
    conversations: await listConversations(store, account.id, { includeTrashed }),
  });
}

export async function handleDeleteConversation(
  request: Request,
  conversationId: string,
): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  const input = await parseBody(request, deleteConversationRequest);
  const store = await getStore();

  if (input.mode === 'purge') {
    if (input.confirm !== 'DELETE') {
      throw badRequest(
        'Purging removes both encrypted copies immediately and cannot be undone. Send confirm: "DELETE" to go ahead.',
      );
    }
    const result = await store.transaction(account.id, (tx) =>
      purgeConversation(tx, account.id, conversationId),
    );
    return jsonResponse({ mode: 'purge', ...result });
  }

  const result = await store.transaction(account.id, (tx) =>
    trashConversation(tx, account.id, conversationId),
  );
  return jsonResponse({ mode: 'trash', ...result });
}

export async function handleRestoreConversation(
  request: Request,
  conversationId: string,
): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  const store = await getStore();
  const result = await store.transaction(account.id, (tx) =>
    restoreConversation(tx, account.id, conversationId),
  );
  return jsonResponse(result);
}

export async function handleDeleteAccount(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  enforceRateLimit(`account-delete:${clientHash(request)}`, getEnv().rateLimits.auth);
  const input = await parseBody(request, accountDeleteRequest);
  if (input.confirmEmail !== account.email) {
    throw badRequest('Type your email address exactly to confirm.');
  }
  const store = await getStore();
  const result = await store.transaction(account.id, (tx) =>
    requestAccountDeletion(tx, account, input.purgeImmediately),
  );
  return jsonResponse({
    scheduled: true,
    executeAfterMs: result.executeAfterMs,
    retentionDays: getEnv().trashRetentionDays,
  });
}
