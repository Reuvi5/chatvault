'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatBytes } from '@chatvault/protocol';
import { Button, Card, EmptyState, Notice } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

export default function TrashPage() {
  const { conversations, api, refreshConversations } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trashed = conversations.filter((entry) => entry.summary.state === 'trashed');

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Trash</h1>
        <Link href="/app" className="muted ml-auto underline">
          Back to the archive
        </Link>
      </div>

      <Notice tone="neutral">
        <p>
          A conversation in the trash is still stored on both providers and can be restored. Once the
          retention window passes, a scheduled job removes both copies and the metadata.
        </p>
      </Notice>

      {trashed.length === 0 ? (
        <Card>
          <EmptyState title="Nothing in the trash" />
        </Card>
      ) : (
        <ul className="space-y-2">
          {trashed.map((entry) => (
            <Card as="li" key={entry.summary.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{entry.manifest?.title ?? entry.summary.id}</p>
                <p className="muted text-xs">
                  {formatBytes(entry.summary.objectCount > 0 ? entry.summary.logicalBytes : 0)} ·
                  deleted{' '}
                  {entry.summary.trashedAtMs
                    ? new Date(entry.summary.trashedAtMs).toLocaleDateString()
                    : 'recently'}
                </p>
              </div>
              <Button
                busy={busy === `restore-${entry.summary.id}`}
                onClick={async () => {
                  setBusy(`restore-${entry.summary.id}`);
                  setError(null);
                  try {
                    await api.restoreConversation(entry.summary.id);
                    await refreshConversations();
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : 'Restore failed.');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Restore
              </Button>
              <Button
                variant="danger"
                busy={busy === `purge-${entry.summary.id}`}
                onClick={async () => {
                  if (
                    !window.confirm(
                      'Remove both encrypted copies of this conversation now? This cannot be undone.',
                    )
                  ) {
                    return;
                  }
                  setBusy(`purge-${entry.summary.id}`);
                  setError(null);
                  try {
                    await api.deleteConversation(entry.summary.id, 'purge', 'DELETE');
                    await refreshConversations();
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : 'Purge failed.');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Delete permanently
              </Button>
            </Card>
          ))}
        </ul>
      )}

      {error ? <Notice tone="danger">{error}</Notice> : null}
    </main>
  );
}
