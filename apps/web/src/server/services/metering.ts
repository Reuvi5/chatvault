/**
 * Usage measurement and the bill estimate (plan §9).
 *
 * The rule the code enforces: a customer is billed for **current logical
 * archive data, once per logical byte**, never once per replica. The second
 * encrypted copy is our cost, not theirs. Objects in the trash are shown
 * separately and are not billed, which matches the proposal in §9.
 */
import {
  BYTES_PER_GB,
  DEFAULT_TRASH_RETENTION_DAYS,
  newId,
  monthBounds,
  monthKey,
  quoteMonth,
  type UsageResponse,
  type UsageSample,
} from '@chatvault/protocol';
import { getEnv } from '../env';
import type { RowOf, Store } from '../db/index';

/** Object states whose bytes count toward the customer's bill. */
export const BILLABLE_OBJECT_STATES = ['primary_stored', 'verified'] as const;

export interface UsageSnapshot {
  logicalBytes: number;
  objectCount: number;
  trashedBytes: number;
  replication: { verifiedBytes: number; pendingBytes: number; failedBytes: number };
}

export async function measureUsage(store: Store, accountId: string): Promise<UsageSnapshot> {
  const [logicalBytes, objectCount, trashedBytes, verifiedBytes, pendingBytes, failedBytes] =
    await Promise.all([
      store.sum('objects', 'ciphertext_bytes', {
        equals: { account_id: accountId },
        in: { column: 'state', values: [...BILLABLE_OBJECT_STATES] },
      }),
      store.count('objects', {
        equals: { account_id: accountId },
        in: { column: 'state', values: [...BILLABLE_OBJECT_STATES] },
      }),
      store.sum('objects', 'ciphertext_bytes', {
        equals: { account_id: accountId, state: 'trashed' },
      }),
      store.sum('objects', 'ciphertext_bytes', {
        equals: { account_id: accountId, state: 'verified' },
      }),
      store.sum('objects', 'ciphertext_bytes', {
        equals: { account_id: accountId, state: 'primary_stored' },
      }),
      store.sum('objects', 'ciphertext_bytes', {
        equals: { account_id: accountId, state: 'replication_failed' },
      }),
    ]);

  return {
    logicalBytes,
    objectCount,
    trashedBytes,
    replication: { verifiedBytes, pendingBytes, failedBytes },
  };
}

/**
 * Append a measurement to the ledger.
 *
 * The ledger is append-only and is what invoices are derived from, so a billing
 * question can always be answered from stored measurements rather than from a
 * recomputation (plan §13 "Immutable usage ledger").
 */
export async function recordUsageSnapshot(
  store: Store,
  accountId: string,
  source: 'snapshot' | 'import' | 'deletion' | 'purge',
): Promise<UsageSnapshot> {
  const snapshot = await measureUsage(store, accountId);
  await store.insert('usage_ledger', {
    id: newId('usg'),
    account_id: accountId,
    at_ms: Date.now(),
    logical_bytes: snapshot.logicalBytes,
    object_count: snapshot.objectCount,
    source,
  });
  return snapshot;
}

export async function usageSamplesForMonth(
  store: Store,
  accountId: string,
  nowMs: number,
): Promise<{ samples: UsageSample[]; carryInBytes: number }> {
  const month = monthBounds(nowMs);
  const rows = await store.find('usage_ledger', {
    equals: { account_id: accountId },
    orderBy: { column: 'at_ms', direction: 'asc' },
    limit: 5000,
  });

  const samples: UsageSample[] = [];
  let carryInBytes = 0;
  for (const row of rows) {
    if (row.at_ms < month.startMs) {
      carryInBytes = row.logical_bytes;
      continue;
    }
    samples.push({ atMs: row.at_ms, logicalBytes: row.logical_bytes });
  }
  return { samples, carryInBytes };
}

export async function buildUsageResponse(
  store: Store,
  account: RowOf<'accounts'>,
  vault: RowOf<'vaults'>,
  options: { nowMs?: number; billingConfigured: boolean } = { billingConfigured: false },
): Promise<UsageResponse> {
  const env = getEnv();
  const nowMs = options.nowMs ?? Date.now();
  const snapshot = await measureUsage(store, account.id);
  const { samples, carryInBytes } = await usageSamplesForMonth(store, account.id, nowMs);

  // Include the live measurement so the estimate reflects this moment.
  const withCurrent: UsageSample[] = [
    ...samples,
    { atMs: nowMs, logicalBytes: snapshot.logicalBytes },
  ];
  const policy = {
    pricePerGbMonth: env.billing.pricePerGbMonth,
    freeAllowanceBytes: env.billing.freeAllowanceBytes,
    minimumCents: env.billing.minimumCents,
  };
  const quote = quoteMonth(withCurrent, nowMs, { carryInBytes, policy });
  const month = monthBounds(nowMs);

  return {
    vaultId: vault.id,
    currentLogicalBytes: snapshot.logicalBytes,
    objectCount: snapshot.objectCount,
    trashedBytes: snapshot.trashedBytes,
    period: { key: monthKey(nowMs), startMs: month.startMs, endMs: month.endMs },
    accrued: {
      byteHours: quote.byteHours,
      gbMonths: quote.gbMonths,
      usd: quote.accruedUsd,
    },
    projected: { usd: quote.projectedUsd, usdWithMinimum: quote.projectedUsdWithMinimum },
    policy: {
      pricePerGbMonth: policy.pricePerGbMonth,
      bytesPerGb: BYTES_PER_GB,
      freeAllowanceBytes: policy.freeAllowanceBytes,
      minimumCents: policy.minimumCents,
      minimumEnforced: policy.minimumCents > 0,
      quotaBytes: account.quota_bytes,
    },
    replication: snapshot.replication,
    samples: withCurrent.slice(-400),
    billing: {
      configured: options.billingConfigured,
      status: options.billingConfigured
        ? (account.billing_status as UsageResponse['billing']['status'])
        : 'unconfigured',
      customerPortalAvailable: options.billingConfigured && Boolean(account.stripe_customer_id),
    },
  };
}

/** Roll the month's accrual into `billing_periods`, ready for reporting. */
export async function accrueBillingPeriod(
  store: Store,
  accountId: string,
  nowMs = Date.now(),
): Promise<RowOf<'billing_periods'>> {
  const env = getEnv();
  const key = monthKey(nowMs);
  const { samples, carryInBytes } = await usageSamplesForMonth(store, accountId, nowMs);
  const snapshot = await measureUsage(store, accountId);
  const quote = quoteMonth(
    [...samples, { atMs: nowMs, logicalBytes: snapshot.logicalBytes }],
    nowMs,
    {
      carryInBytes,
      policy: {
        pricePerGbMonth: env.billing.pricePerGbMonth,
        freeAllowanceBytes: env.billing.freeAllowanceBytes,
        minimumCents: env.billing.minimumCents,
      },
    },
  );

  const existing = await store.findOne('billing_periods', {
    equals: { account_id: accountId, period_key: key },
  });
  const accruedCents = Math.round(quote.accruedUsd * 100);

  if (existing) {
    await store.update('billing_periods', existing.id, {
      gb_months: quote.gbMonths,
      accrued_cents: accruedCents,
      updated_at_ms: nowMs,
    });
    return {
      ...existing,
      gb_months: quote.gbMonths,
      accrued_cents: accruedCents,
      updated_at_ms: nowMs,
    };
  }

  const row: RowOf<'billing_periods'> = {
    id: newId('bp'),
    account_id: accountId,
    period_key: key,
    gb_months: quote.gbMonths,
    accrued_cents: accruedCents,
    reported_cents: 0,
    state: 'open',
    updated_at_ms: nowMs,
  };
  await store.insert('billing_periods', row);
  return row;
}

export function trashRetentionMs(): number {
  const days = getEnv().trashRetentionDays || DEFAULT_TRASH_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}
