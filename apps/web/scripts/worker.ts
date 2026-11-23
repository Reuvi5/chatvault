/**
 * The background worker (plan §5 "Background jobs", §7).
 *
 *   npm run worker            # run forever, one pass a minute
 *   npm run worker -- --once  # a single pass, for cron or a one-off check
 *
 * Each pass is idempotent and safe to run concurrently with the web app:
 *   1. replicate and verify objects on the second provider,
 *   2. spot-check objects that are already verified,
 *   3. execute deletion jobs whose retention window has passed,
 *   4. purge objects whose window has passed,
 *   5. abandon imports that were never completed,
 *   6. clear expired sessions and idempotency keys,
 *   7. accrue usage per account and report it to Stripe when configured.
 */
import { SERVICE_SCOPE, getStore } from '../src/server/db/index';
import { getEnv } from '../src/server/env';
import { log } from '../src/server/log';
import { purgeExpiredSecurityRows } from '../src/server/security';
import { reconcile, runReplication } from '../src/server/services/replication';
import { purgeExpiredObjects, runDeletionJobs } from '../src/server/services/deletion';
import { reapAbandonedImports } from '../src/server/services/imports';
import { accrueBillingPeriod, recordUsageSnapshot } from '../src/server/services/metering';
import { billingConfigured, runBillingCycle } from '../src/server/services/billing';

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);

async function pass(): Promise<void> {
  const store = await getStore();
  const started = Date.now();

  const replication = await runReplication(store, { limit: 200 });
  const spotCheck = await reconcile(store, { sampleSize: 20 });
  const deletions = await runDeletionJobs(store, { limit: 50 });
  const purges = await purgeExpiredObjects(store, { limit: 200 });

  const housekeeping = await store.transaction(SERVICE_SCOPE, async (tx) => {
    const imports = await reapAbandonedImports(tx);
    const security = await purgeExpiredSecurityRows(tx);
    const accounts = await tx.find('accounts', { equals: { state: 'active' }, limit: 100_000 });
    for (const account of accounts) {
      await recordUsageSnapshot(tx, account.id, 'snapshot');
      await accrueBillingPeriod(tx, account.id);
    }
    return { imports, security, accountIds: accounts.map((account) => account.id) };
  });

  const billing = billingConfigured()
    ? await runBillingCycle(store, housekeeping.accountIds)
    : { accounts: housekeeping.accountIds.length, reported: 0 };

  log.info('Worker pass finished', {
    ms: Date.now() - started,
    replication,
    spotCheckMismatches: spotCheck.mismatches.length,
    deletions,
    purgedObjects: purges.purged,
    abandonedImports: housekeeping.imports.imports,
    expiredSessions: housekeeping.security.sessions,
    accounts: billing.accounts,
    usageReported: billing.reported,
  });

  if (spotCheck.mismatches.length > 0) {
    log.error('Spot check found objects that do not match their records', {
      mismatches: spotCheck.mismatches.slice(0, 10),
    });
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const once = process.argv.includes('--once');
  log.info('Worker starting', {
    store: (await getStore()).driver,
    primary: env.primary.label,
    secondary: env.secondary?.label ?? null,
    billingConfigured: billingConfigured(),
    mode: once ? 'single pass' : `every ${String(INTERVAL_MS / 1000)}s`,
  });

  if (once) {
    await pass();
    return;
  }

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info('Worker stopping after this pass');
      stopping = true;
    });
  }

  while (!stopping) {
    try {
      await pass();
    } catch (error) {
      log.error('A worker pass failed; it will be retried', { error });
    }
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

void main().catch((error: unknown) => {
  log.error('The worker could not start', { error });
  process.exit(1);
});
