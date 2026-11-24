'use client';

/* eslint-disable jsx-a11y/no-autofocus --
   This panel opens only when the reader asks to search, and the field is the
   whole point of it, so moving focus there is what they expect. */

/**
 * Search across every unlocked conversation.
 *
 * Everything here happens on the device: pages are decrypted, indexed in
 * memory, and matched locally. No query, token or result ever goes to the
 * server (plan §4, §6).
 */
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { buildCorpus, searchCorpora, type SearchCorpus, type SearchHit } from '@chatvault/client';
import { Button, Card, Notice, ProgressBar, Spinner, TextInput } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const { conversations, messagesByConversation, loadMessages } = useVault();
  const [query, setQuery] = useState('');
  const [attachmentsOnly, setAttachmentsOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const readable = useMemo(
    () => conversations.filter((entry) => entry.manifest && entry.summary.state === 'active'),
    [conversations],
  );

  /* Decrypt everything once, so searching feels instant afterwards. */
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        let done = 0;
        for (const entry of readable) {
          if (cancelled) return;
          await loadMessages(entry.summary.id);
          done += 1;
          setLoaded(done);
        }
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : 'Some conversations could not be read.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // Intentionally keyed on the set of conversations only.
  }, [readable, loadMessages]);

  const corpora = useMemo<SearchCorpus[]>(
    () =>
      readable
        .map((entry) => {
          const messages = messagesByConversation[entry.summary.id];
          if (!messages) return null;
          return buildCorpus(entry.summary.id, entry.manifest?.title ?? entry.summary.id, messages);
        })
        .filter((corpus): corpus is SearchCorpus => corpus !== null),
    [readable, messagesByConversation],
  );

  const hits: SearchHit[] = useMemo(() => {
    if (query.trim().length < 2 && !attachmentsOnly) return [];
    return searchCorpora(corpora, query, {
      attachmentsOnly,
      from: from || null,
      to: to || null,
      limit: 300,
    });
  }, [corpora, query, attachmentsOnly, from, to]);

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Search your archive</h1>
        <Button className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>

      <Card className="space-y-3 p-4">
        <TextInput
          autoFocus
          id="search-query"
          placeholder='Words to find, or "an exact phrase"'
          aria-label="Search your messages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={attachmentsOnly}
              onChange={(event) => setAttachmentsOnly(event.target.checked)}
            />
            Only messages with attachments
          </label>
          <div className="flex items-center gap-2">
            <label htmlFor="search-from">From</label>
            <TextInput
              id="search-from"
              type="date"
              className="w-40"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="search-to">To</label>
            <TextInput
              id="search-to"
              type="date"
              className="w-40"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </div>
        <p className="muted text-xs">
          Search runs on this device over messages that have been decrypted for this session.
        </p>
      </Card>

      {loading ? (
        <Card className="space-y-2 p-4">
          <p className="muted flex items-center gap-2 text-sm">
            <Spinner /> Decrypting conversations ({loaded} of {readable.length})
          </p>
          <ProgressBar value={loaded} max={Math.max(1, readable.length)} />
        </Card>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {hits.length > 0 ? (
        <ul className="space-y-2">
          {hits.map((hit) => (
            <Card as="li" key={`${hit.conversationId}-${String(hit.index)}`} className="p-0">
              <Link
                href={`/app/c/${hit.conversationId}?at=${String(hit.index)}`}
                className="block space-y-1 p-3.5 hover:bg-ink-100/60 dark:hover:bg-ink-800/60"
              >
                <p className="muted flex flex-wrap gap-2 text-xs">
                  <span className="font-medium">{hit.conversationTitle}</span>
                  <span>{hit.message.localTs.replace('T', ' ')}</span>
                  {hit.message.sender ? <span>{hit.message.sender}</span> : null}
                </p>
                <p className="wrap-anywhere text-sm leading-relaxed">
                  {hit.snippet.before}
                  <mark className="rounded bg-warn-300/60 px-0.5">{hit.snippet.match}</mark>
                  {hit.snippet.after}
                </p>
                {hit.message.attachmentFileName ? (
                  <p className="muted text-xs">Attachment: {hit.message.attachmentFileName}</p>
                ) : null}
              </Link>
            </Card>
          ))}
        </ul>
      ) : null}

      {!loading && hits.length === 0 && query.trim().length >= 2 ? (
        <p className="muted text-sm">Nothing matched that search.</p>
      ) : null}
    </main>
  );
}
