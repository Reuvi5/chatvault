/**
 * Vault routes.
 *
 * The server stores the wrapped key bundle and hands it back on request. It
 * cannot unwrap it, so these routes are deliberately dull: write a blob, read a
 * blob, and report usage.
 */
import { createVaultRequest, newId, updateVaultBundleRequest } from '@chatvault/protocol';
import { getStore } from '../db/index';
import { conflict, jsonResponse, notFound, parseBody } from '../http';
import { requireSession } from '../auth/session';
import { recordAudit } from '../security';
import { buildUsageResponse } from '../services/metering';
import { billingConfigured } from '../services/billing';
import { isValidTimeZone } from '@chatvault/parser';

export async function handleCreateVault(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const input = await parseBody(request, createVaultRequest);
  const store = await getStore();

  const existing = await store.findOne('vaults', { equals: { account_id: account.id } });
  if (existing) {
    throw conflict(
      'This account already has an archive key. Unlock it with your passphrase or recovery key instead of creating a new one.',
    );
  }
  if (!isValidTimeZone(input.assumedTimeZone)) {
    throw conflict(`"${input.assumedTimeZone}" is not a timezone this system recognises.`);
  }

  const now = Date.now();
  const vaultId = newId('vlt');
  await store.insert('vaults', {
    id: vaultId,
    account_id: account.id,
    key_id: input.bundle.keyId,
    bundle_json: JSON.stringify(input.bundle),
    assumed_time_zone: input.assumedTimeZone,
    created_at_ms: now,
    updated_at_ms: now,
  });
  await recordAudit(store, {
    accountId: account.id,
    kind: 'vault.created',
    detail: `vault ${vaultId} created with key ${input.bundle.keyId}`,
  });
  return jsonResponse({ vaultId }, { status: 201 });
}

export async function handleUpdateVaultBundle(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const input = await parseBody(request, updateVaultBundleRequest);
  const store = await getStore();

  const vault = await store.findOne('vaults', { equals: { account_id: account.id } });
  if (!vault) throw notFound('This account has no archive key yet.');
  if (vault.key_id !== input.expectedKeyId) {
    throw conflict('This archive key changed somewhere else. Reload before changing it again.');
  }
  if (input.bundle.keyId !== vault.key_id) {
    throw conflict(
      'That bundle is for a different key. Changing a passphrase keeps the same archive key; replacing the key would make the existing archive unreadable.',
    );
  }

  await store.update('vaults', vault.id, {
    bundle_json: JSON.stringify(input.bundle),
    updated_at_ms: Date.now(),
  });
  await recordAudit(store, {
    accountId: account.id,
    kind: 'vault.bundle_updated',
    detail: 'passphrase or recovery key rewrapped',
  });
  return jsonResponse({ ok: true });
}

export async function handleUsage(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const store = await getStore();
  const vault = await store.findOne('vaults', { equals: { account_id: account.id } });
  if (!vault) throw notFound('This account has no archive yet.');
  return jsonResponse(
    await buildUsageResponse(store, account, vault, { billingConfigured: billingConfigured() }),
  );
}
