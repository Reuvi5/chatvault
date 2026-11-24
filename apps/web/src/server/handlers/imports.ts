/**
 * Import routes (plan §10).
 */
import { completeImportRequest, createImportRequest } from '@chatvault/protocol';
import { getStore } from '../db/index';
import { clientHash, jsonResponse, notFound, parseBody } from '../http';
import { requireVerifiedSession } from '../auth/session';
import { enforceRateLimit, withIdempotency } from '../security';
import { getEnv } from '../env';
import { buildImportStatus, completeImport, createImport } from '../services/imports';

export async function handleCreateImport(request: Request): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`imports:${account.id}`, getEnv().rateLimits.upload);
  const input = await parseBody(request, createImportRequest);
  const store = await getStore();

  const vault = await store.findOne('vaults', { equals: { account_id: account.id } });
  if (!vault) throw notFound('Set up your archive key before importing.');

  const result = await withIdempotency(
    {
      accountId: account.id,
      route: 'POST /api/imports',
      key: request.headers.get('idempotency-key'),
      requestBody: input,
    },
    () => store.transaction(account.id, (tx) => createImport(tx, account, vault, input)),
  );
  return jsonResponse(result, { status: 201 });
}

export async function handleCompleteImport(request: Request, importId: string): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`imports:${account.id}`, getEnv().rateLimits.upload);
  const input = await parseBody(request, completeImportRequest);
  const store = await getStore();

  const result = await withIdempotency(
    {
      accountId: account.id,
      route: `POST /api/imports/${importId}/complete`,
      key: request.headers.get('idempotency-key'),
      requestBody: input,
    },
    () => store.transaction(account.id, (tx) => completeImport(tx, account, importId, input)),
  );
  return jsonResponse(result);
}

export async function handleImportStatus(request: Request, importId: string): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`read:${clientHash(request)}`, getEnv().rateLimits.read);
  const store = await getStore();
  const importRow = await store.get('imports', importId);
  if (!importRow || importRow.account_id !== account.id) {
    throw notFound('That import does not exist.');
  }
  return jsonResponse(await buildImportStatus(store, importRow));
}
