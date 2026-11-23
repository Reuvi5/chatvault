/**
 * Operational routes: run replication, report on it, and a health check.
 *
 * In development these are reachable by a signed-in account for its own data,
 * which is how the import screen shows "waiting for the backup copy" turning
 * into "verified" without a separate worker. The scheduled worker
 * (`npm run worker`) uses the same code paths across all accounts.
 */
import { z } from 'zod';
import { getStore } from '../db/index';
import { jsonResponse, parseBody } from '../http';
import { requireSession, requireVerifiedSession } from '../auth/session';
import { enforceRateLimit } from '../security';
import { getEnv } from '../env';
import { getPrimaryDriver, getSecondaryDriver } from '../objects/index';
import { refreshConversationVerification, runReplication } from '../services/replication';
import { measureUsage } from '../services/metering';

const replicateRequest = z.object({ limit: z.number().int().min(1).max(500).default(50) });

export async function handleRunReplication(request: Request): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`replicate:${account.id}`, 120);
  const input = await parseBody(request, replicateRequest);
  const store = await getStore();
  const result = await runReplication(store, { limit: input.limit, accountId: account.id });
  await store.transaction(account.id, (tx) => refreshConversationVerification(tx, account.id));
  return jsonResponse(result);
}

export async function handleOpsStatus(request: Request): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  const store = await getStore();
  const usage = await measureUsage(store, account.id);

  const states = ['pending', 'primary_stored', 'verified', 'replication_failed', 'trashed'] as const;
  const objects: Record<string, number> = {};
  for (const state of states) {
    objects[state] = await store.count('objects', {
      equals: { account_id: account.id, state },
    });
  }
  const deadLettered = await store.count('replicas', {
    equals: { account_id: account.id, state: 'failed' },
  });

  return jsonResponse({
    objects,
    bytes: {
      logical: usage.logicalBytes,
      verified: usage.replication.verifiedBytes,
      pending: usage.replication.pendingBytes,
      failed: usage.replication.failedBytes,
      trashed: usage.trashedBytes,
    },
    deadLettered,
    lastRunMs: null,
    providers: {
      primary: getPrimaryDriver().label,
      secondary: getSecondaryDriver()?.label ?? null,
    },
  });
}

export async function handleHealth(request: Request): Promise<Response> {
  const env = getEnv();
  const store = await getStore();
  const primary = await getPrimaryDriver().health();
  const secondary = (await getSecondaryDriver()?.health()) ?? {
    ok: false,
    detail: 'no secondary provider configured',
  };

  // Authenticated callers get a little more detail; anonymous callers get the
  // bare minimum needed for a load balancer probe.
  const authenticated = await requireSession(request).catch(() => null);
  const body = {
    ok: primary.ok && (secondary.ok || !env.secondary),
    store: store.driver,
    ...(authenticated
      ? {
          primary,
          secondary,
          environment: env.nodeEnv,
          billingConfigured: Boolean(env.billing.stripeSecretKey),
          minimumChargeEnforced: env.billing.minimumCents > 0,
        }
      : {}),
  };
  return jsonResponse(body, { status: body.ok ? 200 : 503 });
}
