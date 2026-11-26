'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@chatvault/protocol';
import {
  buildCorpus,
  buildReadableExport,
  searchCorpora,
  type IntegrityReport,
} from '@chatvault/client';
import { dateIndex } from '@chatvault/client';
import type { CanonicalMessage } from '@chatvault/parser';
import {
  Badge,
  Button,
  Card,
  LiveStatus,
  Notice,
  ProgressBar,
  SkeletonBubbles,
  Spinner,
  TextInput,
} from '@/components/ui';
import { useVault } from '@/components/VaultProvider';
import { MessageTimeline } from '@/components/MessageTimeline';
import { ChatInsights } from '@/components/ChatInsights';
import { Avatar } from '@/components/Avatar';
import { participantLine } from '@/lib/conversationLayout';

/** One shared empty list, so "no messages yet" is identity-stable. */
const NO_MESSAGES: readonly CanonicalMessage[] = [];

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const conversationId = params.id;
  const {
    conversations,
    messagesByConversation,
    loadMessages,
    loadProgress,
    reader,
    api,
    refreshConversations,
  } = useVault();

  const entry = conversations.find((candidate) => candidate.summary.id === conversationId);
  const manifest = entry?.manifest ?? null;

  /* Identity-stable: the provider never mutates a loaded list, and the fallback
     is a shared constant, so search and the date index below only recompute when
     the conversation actually changes. */
  const messages: readonly CanonicalMessage[] =
    messagesByConversation[conversationId] ?? NO_MESSAGES;
  const loaded = Boolean(messagesByConversation[conversationId]);

  const [query, setQuery] = useState('');
  /** Undefined means "whatever the manifest says"; anything else is a choice. */
  const [selfOverride, setSelfOverride] = useState<string | null | undefined>(undefined);
  const [verifying, setVerifying] = useState(false);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWarnings, setShowWarnings] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const highlightParam = search.get('at');
  const highlightIndex = highlightParam === null ? null : Number(highlightParam);

  // Derived, not copied into state by an effect: the manifest already knows.
  const selfName = selfOverride === undefined ? (manifest?.selfName ?? null) : selfOverride;

  useEffect(() => {
    if (!manifest || loaded) return;
    let active = true;
    void (async () => {
      try {
        await loadMessages(conversationId);
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error ? caught.message : 'That conversation could not be read.',
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [manifest, loaded, conversationId, loadMessages]);

  const hits = useMemo(() => {
    if (query.trim().length < 2 || !manifest) return [];
    return searchCorpora([buildCorpus(conversationId, manifest.title, messages)], query, {
      limit: 100,
    });
  }, [query, manifest, messages, conversationId]);

  const days = useMemo(() => dateIndex(messages), [messages]);

  if (!entry) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Notice tone="warn">
          That conversation is not in your index.{' '}
          <Link href="/app" className="underline">
            Back to the archive
          </Link>
          .
        </Notice>
      </main>
    );
  }

  if (!manifest) {
    /*
     * An import that died partway leaves a conversation row with no manifest.
     * Everything below this point needs the manifest, so without an exit here
     * the row is stranded in the archive list with no way to remove it — which
     * is exactly what happened the first time a real import hit the upload
     * rate limit.
     */
    const neverFinished = entry.summary.manifestObjectId === null;
    return (
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-10">
        <Notice
          tone="danger"
          title={
            neverFinished ? 'This import never finished' : 'This conversation could not be read'
          }
        >
          {neverFinished
            ? 'No index was ever written for this conversation, so there is nothing to read. Nothing was lost: whatever did upload is unreferenced, and removing this entry releases it. Import the export again to retry.'
            : (entry.error ??
              'The index for this conversation is unreadable with the current key.')}
        </Notice>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="danger"
            onClick={async () => {
              if (
                !window.confirm(
                  'Remove this entry from your archive? It moves to the trash, and stays restorable for the retention window.',
                )
              ) {
                return;
              }
              await api.deleteConversation(conversationId, 'trash');
              await refreshConversations();
              router.push('/app');
            }}
          >
            Remove from archive
          </Button>
          <Link href="/app/import" className="underline">
            Import it again
          </Link>
          <Link href="/app" className="muted underline">
            Back to the archive
          </Link>
        </div>
      </main>
    );
  }

  const progress = loadProgress?.conversationId === conversationId ? loadProgress : null;
  const missingAttachments = manifest.attachments.filter((item) => item.missing).length;

  return (
    <main className="mx-auto max-w-4xl px-4 py-5">
      <header className="mb-4 space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <Avatar name={manifest.title} size={44} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{manifest.title}</h1>
              {entry.summary.archiveVerified ? (
                <Badge tone="good" title="Verified on two independent providers">
                  Verified
                </Badge>
              ) : (
                <Badge tone="warn">Backing up</Badge>
              )}
            </div>
            {/* Who is in the conversation, named, the way a chat header reads —
                rather than a count, which tells you nothing you wanted. */}
            <p className="mt-0.5 truncate text-xs" title={manifest.participants.join(', ')}>
              {participantLine(manifest.participants, selfName)}
            </p>
            <p className="muted mt-1 text-xs">
              {manifest.messageCount.toLocaleString('en-US')} messages ·{' '}
              {formatBytes(entry.summary.logicalBytes)} · imported {manifest.imports.length} time
              {manifest.imports.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/app" className="surface rounded-lg border hairline px-3 py-2 text-sm">
              Back
            </Link>
            <Link
              href={`/app/import?conversation=${conversationId}`}
              className="surface rounded-lg border hairline px-3 py-2 text-sm"
            >
              Import an update
            </Link>
            <Button
              busy={verifying}
              onClick={async () => {
                if (!reader) return;
                setVerifying(true);
                setError(null);
                try {
                  setReport(await reader.verifyIntegrity(manifest, { includeMedia: true }));
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Verification failed.');
                } finally {
                  setVerifying(false);
                }
              }}
            >
              Check this archive
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            className="w-56"
            placeholder="Find in this conversation"
            aria-label="Find in this conversation"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {days.length > 0 ? (
            <select
              aria-label="Jump to a date"
              className="sunken rounded-lg border hairline px-2.5 py-2 text-sm"
              value=""
              onChange={(event) => {
                const index = Number(event.target.value);
                if (Number.isFinite(index)) {
                  router.replace(`/app/c/${conversationId}?at=${String(index)}`);
                }
              }}
            >
              <option value="">Jump to a date…</option>
              {days.map((day) => (
                <option key={day.date} value={day.index}>
                  {day.date}
                </option>
              ))}
            </select>
          ) : null}
          {manifest.participants.length > 1 ? (
            <select
              aria-label="Which participant is you"
              className="sunken rounded-lg border hairline px-2.5 py-2 text-sm"
              value={selfName ?? ''}
              onChange={(event) => setSelfOverride(event.target.value || null)}
            >
              <option value="">Nobody is me</option>
              {manifest.participants.map((name) => (
                <option key={name} value={name}>
                  I am {name}
                </option>
              ))}
            </select>
          ) : null}
          <Button
            disabled={!loaded}
            aria-expanded={showInsights}
            onClick={() => setShowInsights(!showInsights)}
          >
            {showInsights ? 'Hide insights' : 'Insights'}
          </Button>
          {manifest.warnings.length > 0 ? (
            <Button onClick={() => setShowWarnings(!showWarnings)}>
              {showWarnings ? 'Hide' : 'Show'} coverage notes ({manifest.warnings.length})
            </Button>
          ) : null}
        </div>

        {showWarnings ? (
          <Notice tone="warn" title="What this archive does and does not contain">
            {manifest.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            {missingAttachments > 0 ? (
              <p>
                {missingAttachments} referenced attachment
                {missingAttachments === 1 ? '' : 's'} were not in the export and are marked as
                missing.
              </p>
            ) : null}
          </Notice>
        ) : null}

        {report ? (
          <Notice tone={report.ok ? 'good' : 'danger'} title="Archive check">
            <p>
              {report.pagesChecked} message pages and {report.attachmentsChecked} attachments were
              downloaded, decrypted and compared with the index.
            </p>
            <p>
              {report.ok
                ? `All ${report.messageCount.toLocaleString('en-US')} messages read back correctly.`
                : `${report.problems.length} object(s) did not check out.`}
            </p>
            {report.problems.slice(0, 5).map((problem) => (
              <p key={problem.objectId}>
                {problem.kind} {problem.objectId}: {problem.detail}
              </p>
            ))}
          </Notice>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}
      </header>

      {progress ? (
        <Card className="mb-4 space-y-2 p-4">
          <p className="muted flex items-center gap-2 text-sm">
            <Spinner /> Decrypting pages ({progress.done} of {progress.total})
          </p>
          <ProgressBar value={progress.done} max={Math.max(1, progress.total)} />
        </Card>
      ) : null}

      {showInsights && loaded ? <ChatInsights messages={messages} /> : null}

      {hits.length > 0 ? (
        <Card className="mb-4 divide-y hairline p-0">
          <p className="muted px-3.5 py-2 text-xs">
            {hits.length} match{hits.length === 1 ? '' : 'es'}
          </p>
          {hits.slice(0, 25).map((hit) => (
            <button
              key={hit.index}
              type="button"
              onClick={() => router.replace(`/app/c/${conversationId}?at=${String(hit.index)}`)}
              className="block w-full px-3.5 py-2 text-left text-sm hover:bg-ink-100/60 dark:hover:bg-ink-800/60"
            >
              <span className="muted mr-2 text-xs">{hit.message.localTs.replace('T', ' ')}</span>
              {hit.snippet.before}
              <mark className="rounded bg-warn-300/60 px-0.5">{hit.snippet.match}</mark>
              {hit.snippet.after}
            </button>
          ))}
        </Card>
      ) : null}

      {loaded ? (
        <MessageTimeline
          manifest={manifest}
          messages={messages}
          selfName={selfName}
          highlightIndex={highlightIndex}
        />
      ) : (
        <>
          <LiveStatus>Decrypting this conversation</LiveStatus>
          <SkeletonBubbles rows={8} />
        </>
      )}

      <footer className="mt-8 flex flex-wrap items-center gap-3 border-t hairline pt-4">
        <Button
          busy={exporting}
          onClick={async () => {
            if (!reader) return;
            setExporting(true);
            setError(null);
            setExportNote(null);
            try {
              const result = await buildReadableExport({ reader, manifest, messages });
              const blob = new Blob([result.bytes as unknown as BlobPart], {
                type: 'application/zip',
              });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = result.fileName;
              link.click();
              URL.revokeObjectURL(url);
              setExportNote(
                `Downloaded ${String(result.messageCount)} messages and ${String(result.attachmentCount)} attachments.`,
              );
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'The download failed.');
            } finally {
              setExporting(false);
            }
          }}
        >
          Download a readable copy
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            if (
              !window.confirm(
                'Move this conversation to the trash? It stays restorable for the retention window, and nothing is removed from storage yet.',
              )
            ) {
              return;
            }
            await api.deleteConversation(conversationId, 'trash');
            await refreshConversations();
            router.push('/app');
          }}
        >
          Move to trash
        </Button>
        <p className="muted text-xs">
          Keep your original export until you have checked this archive reads correctly.
        </p>
        {exportNote ? <Notice tone="good">{exportNote}</Notice> : null}
      </footer>
    </main>
  );
}
