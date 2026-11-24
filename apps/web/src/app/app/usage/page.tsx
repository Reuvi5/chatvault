'use client';

import { useCallback, useEffect, useState } from 'react';
import { BYTES_PER_GB, formatBytes, formatUsd, type UsageResponse } from '@chatvault/protocol';
import { ApiRequestError } from '@chatvault/client';
import { Badge, Button, Card, LiveStatus, Notice, Skeleton, Stat } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

export default function UsagePage() {
  const { api } = useVault();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setUsage(await api.usage());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Usage could not be loaded.');
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) await refresh();
    })();
    return () => {
      active = false;
    };
  }, [refresh]);

  if (!usage) {
    return (
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <h1 className="text-xl font-semibold">Storage and billing</h1>
        {error ? (
          <Notice tone="danger">{error}</Notice>
        ) : (
          <>
            <LiveStatus>Loading your storage and billing figures</LiveStatus>
            <Card className="p-5">
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
                {Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="space-y-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-6 w-24" />
                  </div>
                ))}
              </div>
            </Card>
            <Card className="space-y-2 p-5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </Card>
          </>
        )}
      </main>
    );
  }

  const quotaUsed =
    usage.policy.quotaBytes > 0 ? usage.currentLogicalBytes / usage.policy.quotaBytes : 0;

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold">Storage and billing</h1>

      <Card className="p-5">
        <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat
            label="Stored now"
            value={formatBytes(usage.currentLogicalBytes)}
            hint={`${usage.objectCount.toLocaleString('en-US')} encrypted objects`}
          />
          <Stat
            label="This month so far"
            value={formatUsd(usage.accrued.usd)}
            hint={`${usage.accrued.gbMonths.toFixed(4)} GB-months`}
          />
          <Stat
            label="Projected"
            value={formatUsd(usage.projected.usd)}
            hint={
              usage.policy.minimumEnforced
                ? `minimum ${formatUsd(usage.policy.minimumCents / 100)} applies`
                : 'no minimum charge'
            }
          />
          <Stat
            label="In the trash"
            value={formatBytes(usage.trashedBytes)}
            hint="kept for the retention window, not billed"
          />
        </dl>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">How this is worked out</h2>
        <ul className="muted space-y-1.5 text-sm leading-relaxed">
          <li>
            {formatUsd(usage.policy.pricePerGbMonth)} per GB-month, where a GB is{' '}
            {BYTES_PER_GB.toLocaleString('en-US')} bytes.
          </li>
          <li>
            Measured by integrating what you store over time, so adding data mid-month is prorated
            to the hour.
          </li>
          <li>
            Billed once for your data. The second encrypted copy is kept at our cost, not yours.
          </li>
          <li>
            {usage.policy.freeAllowanceBytes > 0
              ? `The first ${formatBytes(usage.policy.freeAllowanceBytes)} are not billed.`
              : 'There is no free allowance and no minimum charge configured.'}
          </li>
        </ul>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">Backup coverage</h2>
        <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
          <Stat label="Verified on both" value={formatBytes(usage.replication.verifiedBytes)} />
          <Stat label="Waiting for backup" value={formatBytes(usage.replication.pendingBytes)} />
          <Stat label="Failed" value={formatBytes(usage.replication.failedBytes)} />
        </dl>
        {usage.replication.failedBytes > 0 ? (
          <Notice tone="danger">
            Some objects could not be copied to the backup provider. They are still on the primary,
            but those conversations will not show as verified.
          </Notice>
        ) : null}
      </Card>

      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Payment</h2>
          <Badge tone={usage.billing.configured ? 'accent' : 'neutral'}>
            {usage.billing.status}
          </Badge>
        </div>
        {usage.billing.configured ? (
          <>
            <p className="muted text-sm">
              Usage is reported to Stripe as GB-months. Quota on this account:{' '}
              {formatBytes(usage.policy.quotaBytes)} ({Math.round(quotaUsed * 100)}% used).
            </p>
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api.startCheckout('/app/usage');
                  window.location.href = result.url;
                } catch (caught) {
                  setError(
                    caught instanceof ApiRequestError
                      ? caught.message
                      : 'Checkout failed to start.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Manage payment
            </Button>
          </>
        ) : (
          <p className="muted text-sm leading-relaxed">
            Billing is not configured on this deployment, so nothing is charged. Usage is still
            measured and recorded, which is what an invoice would be built from.
          </p>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Card>
    </main>
  );
}
