'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { formatBytes } from '@chatvault/protocol';
import { Badge, Button, Card, EmptyState, Notice, Spinner, TextInput } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';
import { GlobalSearch } from '@/components/GlobalSearch';

function relativeDay(localTs: string | null): string {
  if (!localTs) return '—';
  return localTs.slice(0, 10);
}

export default function ArchivePage() {
  const { conversations, conversationsLoading, refreshConversations } = useVault();
  const [filter, setFilter] = useState('');
  const [searching, setSearching] = useState(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const active = conversations.filter((entry) => entry.summary.state === 'active');
    if (!needle) return active;
    return active.filter((entry) => {
      const manifest = entry.manifest;
      if (!manifest) return false;
      return (
        manifest.title.toLowerCase().includes(needle) ||
        manifest.participants.some((name) => name.toLowerCase().includes(needle))
      );
    });
  }, [conversations, filter]);

  const trashed = conversations.filter((entry) => entry.summary.state === 'trashed');

  if (searching) {
    return <GlobalSearch onClose={() => setSearching(false)} />;
  }

  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Your archive</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TextInput
            placeholder="Filter conversations"
            aria-label="Filter conversations by name"
            className="w-48"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <Button onClick={() => setSearching(true)}>Search messages</Button>
          <Button onClick={() => void refreshConversations()} busy={conversationsLoading}>
            Refresh
          </Button>
          <Link
            href="/app/import"
            className="rounded-lg bg-accent-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-600"
          >
            Import a chat
          </Link>
        </div>
      </div>

      {conversationsLoading && conversations.length === 0 ? (
        <p className="muted flex items-center gap-2 text-sm">
          <Spinner /> Decrypting your conversation index…
        </p>
      ) : null}

      {conversations.some((entry) => entry.error) ? (
        <Notice tone="warn" title="Some conversations could not be read">
          {conversations
            .filter((entry) => entry.error)
            .slice(0, 3)
            .map((entry) => (
              <p key={entry.summary.id}>
                {entry.summary.id}: {entry.error}
              </p>
            ))}
        </Notice>
      ) : null}

      {visible.length === 0 && !conversationsLoading ? (
        <Card>
          <EmptyState
            title={conversations.length === 0 ? 'Nothing archived yet' : 'No conversations match'}
            action={
              conversations.length === 0 ? (
                <Link
                  href="/app/import"
                  className="rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-600"
                >
                  Import your first export
                </Link>
              ) : null
            }
          >
            {conversations.length === 0 ? (
              <>
                Export a conversation from your messaging app, then import the <code>.zip</code> or{' '}
                <code>.txt</code> file here. It is parsed and encrypted on this device before
                anything is uploaded.
              </>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((entry) => {
            const manifest = entry.manifest;
            return (
              <Card as="li" key={entry.summary.id} className="p-0">
                <Link
                  href={`/app/c/${entry.summary.id}`}
                  className="block space-y-2 p-4 hover:bg-ink-100/60 dark:hover:bg-ink-800/60"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-medium leading-snug">
                      {manifest?.title ?? 'Unreadable conversation'}
                    </h2>
                    {entry.summary.archiveVerified ? (
                      <Badge tone="good" title="Two verified encrypted copies exist">
                        Verified
                      </Badge>
                    ) : (
                      <Badge tone="warn" title="Waiting for the second encrypted copy">
                        Backing up
                      </Badge>
                    )}
                  </div>
                  <p className="muted text-xs">
                    {manifest ? (
                      <>
                        {manifest.messageCount.toLocaleString('en-US')} messages ·{' '}
                        {manifest.isGroup ? `${String(manifest.participants.length)} people` : '1:1'}{' '}
                        · {formatBytes(entry.summary.logicalBytes)}
                      </>
                    ) : (
                      formatBytes(entry.summary.logicalBytes)
                    )}
                  </p>
                  <p className="muted text-xs">
                    {relativeDay(manifest?.firstLocalTs ?? null)} →{' '}
                    {relativeDay(manifest?.lastLocalTs ?? null)}
                  </p>
                  {manifest && manifest.attachments.some((item) => item.missing) ? (
                    <p className="text-xs text-warn-500">
                      {manifest.attachments.filter((item) => item.missing).length} attachments were
                      not in the export
                    </p>
                  ) : null}
                </Link>
              </Card>
            );
          })}
        </ul>
      )}

      {trashed.length > 0 ? (
        <p className="muted text-sm">
          {trashed.length} conversation{trashed.length === 1 ? '' : 's'} in the trash.{' '}
          <Link href="/app/trash" className="underline">
            Review them
          </Link>
          .
        </p>
      ) : null}
    </main>
  );
}
