'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatBytes, type ImportStatusResponse } from '@chatvault/protocol';
import { Badge, Button, Card, Notice, Spinner, Stat } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

export default function ImportStatusPage() {
  const params = useParams<{ id: string }>();
  const { api, refreshConversations } = useVault();
  const [status, setStatus] = useState<ImportStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.importStatus(params.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That import could not be found.');
    }
  }, [api, params.id]);

  /* Poll while this page is open, and stop cleanly when it is not. */
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!active) return;
      await refresh();
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const replicate = async () => {
    setBusy(true);
    try {
      await api.runReplication(200);
      await refresh();
      await refreshConversations();
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Notice tone="danger">{error}</Notice>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p className="muted flex items-center gap-2 text-sm">
          <Spinner /> Loading the import…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Import status</h1>
        <Badge tone={status.archiveVerified ? 'good' : 'warn'}>
          {status.archiveVerified ? 'Archive verified' : status.state.replace('_', ' ')}
        </Badge>
        <Link href={`/app/c/${status.conversationId}`} className="ml-auto underline">
          Open the conversation
        </Link>
      </header>

      <Card className="p-5">
        <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="Objects" value={status.objects.total} />
          <Stat label="On the primary" value={status.objects.primaryStored} />
          <Stat label="Verified on both" value={status.objects.verified} />
          <Stat label="Encrypted size" value={formatBytes(status.logicalBytes)} />
        </dl>
      </Card>

      {status.objects.failed > 0 ? (
        <Notice tone="danger" title="Some objects could not be copied to the backup provider">
          <p>
            {status.objects.failed} object(s) were parked after repeated failures. Your data is
            still on the primary provider, but this conversation will not show as verified until the
            backup copy succeeds.
          </p>
        </Notice>
      ) : null}

      {!status.archiveVerified ? (
        <Card className="space-y-3 p-5">
          <h2 className="text-base font-semibold">Waiting for the second copy</h2>
          <p className="muted text-sm leading-relaxed">
            A conversation is only marked verified once every object exists on two independent
            providers and the index can be recovered. In deployment a scheduled worker does this;
            you can also run it now.
          </p>
          <Button busy={busy} onClick={() => void replicate()}>
            Make the backup copy now
          </Button>
        </Card>
      ) : (
        <Notice tone="good" title="Two verified encrypted copies exist">
          <p>
            Every object in this conversation was read back from both providers and matched the
            checksum recorded when it was encrypted. It is still worth opening the conversation and
            reading a few messages before you delete your original export.
          </p>
        </Notice>
      )}

      {status.lastError ? <Notice tone="danger">{status.lastError}</Notice> : null}
    </main>
  );
}
