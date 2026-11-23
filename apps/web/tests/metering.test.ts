/**
 * Usage measurement and the bill estimate, end to end (plan §9, §12).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BYTES_PER_GB, PRICE_USD_PER_GB_MONTH, hoursInMonth, monthKey } from '@chatvault/protocol';
import {
  cleanupDataDir,
  createAccount,
  getStore,
  importFixture,
  type TestAccount,
} from './harness';
import { accrueBillingPeriod, measureUsage } from '@/server/services/metering';

let account: TestAccount;
let conversationId: string;
let importedBytes: number;

beforeAll(async () => {
  account = await createAccount();
  const { outcome } = await importFixture(account, { messageCount: 40, seed: 21 });
  conversationId = outcome.conversationId;
  importedBytes = outcome.ciphertextBytesUploaded;
}, 120_000);

afterAll(async () => {
  await cleanupDataDir();
});

describe('what is measured', () => {
  it('counts the ciphertext actually stored, once per logical byte', async () => {
    const store = await getStore();
    const usage = await account.api.usage();
    const objects = await store.find('objects', {
      equals: { account_id: account.accountId },
      in: { column: 'state', values: ['primary_stored', 'verified'] },
    });
    const total = objects.reduce((sum, object) => sum + object.ciphertext_bytes, 0);

    expect(usage.currentLogicalBytes).toBe(total);
    expect(usage.currentLogicalBytes).toBe(importedBytes);
    expect(usage.objectCount).toBe(objects.length);

    // Two copies exist, but the customer sees one.
    const replicas = await store.count('replicas', { equals: { account_id: account.accountId } });
    expect(replicas).toBe(objects.length * 2);
  });

  it('writes an immutable ledger row for the import', async () => {
    const store = await getStore();
    const rows = await store.find('usage_ledger', {
      equals: { account_id: account.accountId },
      orderBy: { column: 'at_ms', direction: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.source === 'import')).toBe(true);
    expect(rows.at(-1)?.logical_bytes).toBe(importedBytes);
  });

  it('prices the archive at five cents per GB-month', async () => {
    const usage = await account.api.usage();
    expect(usage.policy.pricePerGbMonth).toBe(PRICE_USD_PER_GB_MONTH);
    expect(usage.policy.bytesPerGb).toBe(BYTES_PER_GB);

    const fullMonthUsd = (usage.currentLogicalBytes / BYTES_PER_GB) * PRICE_USD_PER_GB_MONTH;
    // The projection assumes current usage continues to month end, so it is at
    // most a full month's charge and at least the part already accrued.
    expect(usage.projected.usd).toBeLessThanOrEqual(fullMonthUsd * 1.0001);
    expect(usage.projected.usd).toBeGreaterThanOrEqual(usage.accrued.usd);
  });

  it('does not enforce a minimum charge or a free allowance by default', async () => {
    const usage = await account.api.usage();
    expect(usage.policy.minimumEnforced).toBe(false);
    expect(usage.policy.minimumCents).toBe(0);
    expect(usage.policy.freeAllowanceBytes).toBe(0);
    expect(usage.projected.usdWithMinimum).toBe(usage.projected.usd);
  });

  it('reports what is still waiting for its backup copy', async () => {
    const before = await account.api.usage();
    expect(before.replication.pendingBytes).toBe(before.currentLogicalBytes);
    expect(before.replication.verifiedBytes).toBe(0);

    await account.api.runReplication(500);

    const after = await account.api.usage();
    expect(after.replication.verifiedBytes).toBe(after.currentLogicalBytes);
    expect(after.replication.pendingBytes).toBe(0);
    expect(after.currentLogicalBytes).toBe(before.currentLogicalBytes);
  });
});

describe('what is not billed', () => {
  it('stops billing data in the trash, and resumes when it is restored', async () => {
    const before = await account.api.usage();
    expect(before.currentLogicalBytes).toBeGreaterThan(0);

    await account.api.deleteConversation(conversationId, 'trash');
    const trashed = await account.api.usage();
    expect(trashed.currentLogicalBytes).toBe(0);
    expect(trashed.trashedBytes).toBe(before.currentLogicalBytes);

    await account.api.restoreConversation(conversationId);
    const restored = await account.api.usage();
    expect(restored.currentLogicalBytes).toBe(before.currentLogicalBytes);
    expect(restored.trashedBytes).toBe(0);
  });

  it('does not bill objects that never finished uploading', async () => {
    const before = await account.api.usage();
    const created = await account.api.createImport({
      plannedCiphertextBytes: 1000,
      plannedObjectCount: 1,
      parserVersion: 1,
      cryptoVersion: 1,
    });
    await account.api.authorizeUpload({
      importId: created.importId,
      kind: 'media',
      expectedCiphertextBytes: 1000,
    });
    const after = await account.api.usage();
    expect(after.currentLogicalBytes).toBe(before.currentLogicalBytes);
  });
});

describe('billing periods', () => {
  it('accrues GB-months for the current calendar month', async () => {
    const store = await getStore();
    const period = await accrueBillingPeriod(store, account.accountId);
    expect(period.period_key).toBe(monthKey(Date.now()));
    expect(period.gb_months).toBeGreaterThanOrEqual(0);
    expect(period.reported_cents).toBe(0);

    // Accruing twice updates the same row rather than creating a second one.
    const again = await accrueBillingPeriod(store, account.accountId);
    expect(again.id).toBe(period.id);
    const rows = await store.find('billing_periods', {
      equals: { account_id: account.accountId, period_key: period.period_key },
    });
    expect(rows).toHaveLength(1);
  });

  it('turns stored bytes into GB-months using the real length of the month', async () => {
    const store = await getStore();
    const usage = await measureUsage(store, account.accountId);
    const hours = hoursInMonth(Date.now());
    expect([672, 696, 720, 744]).toContain(hours);
    // A sanity bound: a month of this archive costs less than a dollar.
    const monthUsd = (usage.logicalBytes / BYTES_PER_GB) * PRICE_USD_PER_GB_MONTH;
    expect(monthUsd).toBeLessThan(1);
  });

  it('says plainly when payment is not configured', async () => {
    const usage = await account.api.usage();
    expect(usage.billing.configured).toBe(false);
    expect(usage.billing.status).toBe('unconfigured');
  });
});
