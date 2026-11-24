'use client';

/**
 * The import wizard (plan §3 "Import a chat").
 *
 * Step 1 reads and parses the export **locally** and shows what was found,
 * including what is missing, before anything is uploaded. Step 2 encrypts and
 * uploads. Step 3 reports what is stored, what is still being copied, and tells
 * the person to keep their original until they have checked the archive.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BYTES_PER_GB,
  PRICE_USD_PER_GB_MONTH,
  formatBytes,
  formatUsd,
  type ImportStatusResponse,
} from '@chatvault/protocol';
import {
  fileImportSource,
  previewImport,
  runImport,
  type ImportOutcome,
  type ImportPreview,
  type ImportProgress,
} from '@chatvault/client';
import { mergeMessages, type DateOrder } from '@chatvault/parser';
import {
  Badge,
  Button,
  Card,
  Field,
  LiveStatus,
  Notice,
  ProgressBar,
  Spinner,
  TextInput,
} from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

type Phase = 'choose' | 'previewing' | 'review' | 'uploading' | 'done';

export function ImportWizard({ targetConversationId }: { targetConversationId?: string | null }) {
  const {
    api,
    vault,
    assumedTimeZone,
    conversations,
    refreshConversations,
    loadMessages,
    messagesByConversation,
  } = useVault();

  const [phase, setPhase] = useState<Phase>('choose');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null);
  const [title, setTitle] = useState('');
  const [selfName, setSelfName] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(targetConversationId ?? null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [status, setStatus] = useState<ImportStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bytesRead, setBytesRead] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const target = conversations.find((entry) => entry.summary.id === conversationId);
  const existingMessages = conversationId ? messagesByConversation[conversationId] : undefined;

  useEffect(() => {
    if (conversationId && !existingMessages) void loadMessages(conversationId);
  }, [conversationId, existingMessages, loadMessages]);

  const runPreview = useCallback(
    async (chosen: File, order: DateOrder | null) => {
      setPhase('previewing');
      setError(null);
      setBytesRead(0);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await previewImport({
          source: fileImportSource(chosen),
          signal: controller.signal,
          onProgress: setBytesRead,
          ...(order ? { dateOrder: order } : {}),
        });
        setPreview(result);
        setTitle(target?.manifest?.title ?? result.title);
        setSelfName(target?.manifest?.selfName ?? result.selfName);
        setPhase('review');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That file could not be read.');
        setPhase('choose');
      }
    },
    [target],
  );

  const mergePreview = useMemo(() => {
    if (!preview) return null;
    return mergeMessages(existingMessages ?? [], preview.parsed.messages);
  }, [preview, existingMessages]);

  const estimatedMonthlyCost = preview
    ? ((existingMessages ? (mergePreview?.added ?? 0) : 1) === 0
        ? 0
        : preview.estimates.estimatedCiphertextBytes / BYTES_PER_GB) * PRICE_USD_PER_GB_MONTH
    : 0;

  async function startUpload() {
    if (!preview || !file || !vault) return;
    setPhase('uploading');
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runImport({
        api,
        vault,
        source: fileImportSource(file),
        preview,
        assumedTimeZone,
        conversationId,
        existingManifest: target?.manifest ?? null,
        existingMessages: existingMessages ?? [],
        title,
        selfName,
        onProgress: setProgress,
        signal: controller.signal,
      });
      setOutcome(result);
      setPhase('done');
      await refreshConversations();

      // Ask the server to make the second copy now, then report what it says.
      try {
        await api.runReplication(200);
      } catch {
        /* the scheduled worker will pick it up */
      }
      setStatus(await api.importStatus(result.importId));
      await refreshConversations();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The import did not finish.');
      setPhase('review');
    }
  }

  /* ----------------------------------------------------------- choose ---- */

  if (phase === 'choose' || phase === 'previewing') {
    return (
      <div className="space-y-4">
        <Card className="space-y-4 p-5">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Choose an export</h2>
            <p className="muted text-sm leading-relaxed">
              In your messaging app, open the conversation, choose its export option, and include
              media if you want the photos and voice notes archived. Then pick the <code>.zip</code>{' '}
              or <code>.txt</code> file here.
            </p>
          </div>

          <label className="sunken flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed hairline px-6 py-10 text-center">
            <span className="text-sm font-medium">Pick a file, or drop one here</span>
            <span className="muted text-xs">
              Nothing is uploaded at this step. The file is read and parsed on this device.
            </span>
            <input
              type="file"
              accept=".zip,.txt,application/zip,text/plain"
              className="sr-only"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) {
                  setFile(chosen);
                  void runPreview(chosen, dateOrder);
                }
              }}
            />
          </label>

          {conversations.length > 0 ? (
            <Field
              label="Add to an existing conversation?"
              id="target"
              hint="Choose the conversation this export belongs to, and ChatVault will merge it without duplicating what you already have."
            >
              <select
                id="target"
                className="sunken w-full rounded-lg border hairline px-3 py-2 text-sm"
                value={conversationId ?? ''}
                onChange={(event) => setConversationId(event.target.value || null)}
              >
                <option value="">Start a new conversation</option>
                {conversations
                  .filter((entry) => entry.manifest && entry.summary.state === 'active')
                  .map((entry) => (
                    <option key={entry.summary.id} value={entry.summary.id}>
                      {entry.manifest?.title}
                    </option>
                  ))}
              </select>
            </Field>
          ) : null}

          {phase === 'previewing' ? (
            <p className="muted flex items-center gap-2 text-sm">
              <Spinner /> Reading and parsing locally… {formatBytes(bytesRead)} read
            </p>
          ) : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </Card>
      </div>
    );
  }

  /* ----------------------------------------------------------- review ---- */

  if (phase === 'review' && preview) {
    const parsed = preview.parsed;
    const missing = preview.attachments.filter((item) => item.missing);
    const present = preview.attachments.filter((item) => !item.missing);

    return (
      <div className="space-y-4">
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">What this export contains</h2>
            <Badge tone="accent">{preview.source.kind === 'zip' ? 'Archive' : 'Transcript'}</Badge>
            <span className="muted text-xs">
              {preview.source.fileName} · {formatBytes(preview.source.byteLength)}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Messages</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {parsed.counts.total.toLocaleString('en-US')}
              </dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">People</dt>
              <dd className="text-lg font-semibold tabular-nums">{parsed.participants.length}</dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Attachments</dt>
              <dd className="text-lg font-semibold tabular-nums">{present.length}</dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Covers</dt>
              <dd className="text-sm font-medium">
                {parsed.firstLocalTs?.slice(0, 10) ?? '—'} →{' '}
                {parsed.lastLocalTs?.slice(0, 10) ?? '—'}
              </dd>
            </div>
          </dl>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Conversation name" id="title">
              <TextInput
                id="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field
              label="Which participant is you?"
              id="self"
              hint="Used to decide which side of the conversation each message sits on."
            >
              <select
                id="self"
                className="sunken w-full rounded-lg border hairline px-3 py-2 text-sm"
                value={selfName ?? ''}
                onChange={(event) => setSelfName(event.target.value || null)}
              >
                <option value="">Do not mark anyone as me</option>
                {parsed.participants.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field
            label="Date order"
            id="order"
            hint={
              parsed.dateOrderConfidence === 'certain'
                ? 'Determined from the dates in this file.'
                : 'This file could be read either way. Check a date below and change this if it looks wrong.'
            }
          >
            <div className="flex items-center gap-2">
              <select
                id="order"
                className="sunken rounded-lg border hairline px-3 py-2 text-sm"
                value={dateOrder ?? parsed.dateOrder}
                onChange={(event) => {
                  const next = event.target.value as DateOrder;
                  setDateOrder(next);
                  if (file) void runPreview(file, next);
                }}
              >
                <option value="dmy">Day first (17/11/2026)</option>
                <option value="mdy">Month first (11/17/2026)</option>
                <option value="ymd">Year first (2026-11-17)</option>
              </select>
              <Badge tone={parsed.dateOrderConfidence === 'certain' ? 'good' : 'warn'}>
                {parsed.dateOrderConfidence}
              </Badge>
            </div>
          </Field>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">First few messages, as ChatVault read them</h3>
            <ul className="sunken divide-y hairline rounded-lg border hairline text-xs">
              {parsed.messages.slice(0, 6).map((message, index) => (
                <li key={index} className="px-3 py-2">
                  <span className="muted mr-2 tabular-nums">
                    {message.localTs.replace('T', ' ')}
                  </span>
                  {message.sender ? <strong className="mr-1">{message.sender}:</strong> : null}
                  <span className="wrap-anywhere">
                    {message.attachmentFileName
                      ? `[${message.attachmentFileName}]`
                      : message.body.slice(0, 160)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        {mergePreview && existingMessages && existingMessages.length > 0 ? (
          <Card className="space-y-2 p-5">
            <h3 className="text-base font-semibold">Merging into “{target?.manifest?.title}”</h3>
            <ul className="text-sm">
              <li>{mergePreview.added.toLocaleString('en-US')} new messages would be added.</li>
              <li>
                {mergePreview.duplicatesSkipped.toLocaleString('en-US')} were already in your
                archive.
              </li>
              {mergePreview.missingFromNewExport > 0 ? (
                <li>
                  {mergePreview.missingFromNewExport.toLocaleString('en-US')} messages in your
                  archive are not in this export. They will be kept.
                </li>
              ) : null}
            </ul>
            {mergePreview.ambiguities.length > 0 ? (
              <Notice tone="warn" title="Worth a look before importing">
                {mergePreview.ambiguities.slice(0, 4).map((item, index) => (
                  <p key={index}>
                    {item.localTs} {item.sender ? `· ${item.sender}` : ''} — {item.detail}
                  </p>
                ))}
              </Notice>
            ) : null}
          </Card>
        ) : null}

        {preview.warnings.length > 0 || missing.length > 0 ? (
          <Notice tone="warn" title="What is missing or uncertain">
            {preview.warnings.map((warning) => (
              <p key={warning.code + warning.message}>
                {warning.message}
                {warning.count ? ` (${String(warning.count)})` : ''}
              </p>
            ))}
            {missing.length > 0 ? (
              <p>
                Missing files include:{' '}
                {missing
                  .slice(0, 3)
                  .map((item) => item.fileName)
                  .join(', ')}
                {missing.length > 3 ? ` and ${String(missing.length - 3)} more` : ''}.
              </p>
            ) : null}
          </Notice>
        ) : null}

        <Card className="space-y-3 p-5">
          <h3 className="text-base font-semibold">What this will store and cost</h3>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Encrypted size</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {formatBytes(preview.estimates.estimatedCiphertextBytes)}
              </dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Each month</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {formatUsd(estimatedMonthlyCost)}
              </dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Copies kept</dt>
              <dd className="text-lg font-semibold tabular-nums">2</dd>
            </div>
          </dl>
          <p className="muted text-xs leading-relaxed">
            You are billed for one copy of your data, {formatUsd(PRICE_USD_PER_GB_MONTH)} per GB per
            month, measured by the hour. The second encrypted copy is ours to pay for. Files in the
            archive that no message refers to are not uploaded.
          </p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void startUpload()}>
              Encrypt and upload
            </Button>
            <Button
              onClick={() => {
                setPhase('choose');
                setPreview(null);
                setFile(null);
              }}
            >
              Choose a different file
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  /* ---------------------------------------------------------- uploading -- */

  if (phase === 'uploading') {
    return (
      <Card className="space-y-4 p-5">
        <h2 className="text-lg font-semibold">Encrypting and uploading</h2>
        <p className="muted flex items-center gap-2 text-sm">
          <Spinner /> {progress?.label ?? 'Starting…'}
        </p>
        <LiveStatus>{progress?.label ?? 'Starting the import'}</LiveStatus>
        <ProgressBar
          value={progress?.bytesDone ?? 0}
          max={Math.max(1, progress?.bytesTotal ?? 1)}
        />
        <p className="muted text-xs tabular-nums">
          {formatBytes(progress?.bytesDone ?? 0)} of about {formatBytes(progress?.bytesTotal ?? 0)}{' '}
          · object {progress?.objectsDone ?? 0} of {progress?.objectsTotal ?? 0}
        </p>
        <p className="muted text-xs">
          Everything is encrypted on this device before it is sent. Leave this tab open until it
          finishes; interrupted parts are retried automatically.
        </p>
        <Button
          onClick={() => {
            abortRef.current?.abort();
          }}
        >
          Cancel
        </Button>
      </Card>
    );
  }

  /* --------------------------------------------------------------- done -- */

  if (phase === 'done' && outcome) {
    return (
      <div className="space-y-4">
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Imported</h2>
            {status?.archiveVerified ? (
              <Badge tone="good">Verified on both providers</Badge>
            ) : (
              <Badge tone="warn">Backup copy in progress</Badge>
            )}
          </div>

          <ul className="space-y-1 text-sm">
            <li>
              {outcome.merge.added.toLocaleString('en-US')} messages added
              {outcome.merge.duplicatesSkipped > 0
                ? `, ${outcome.merge.duplicatesSkipped.toLocaleString('en-US')} already present`
                : ''}
              .
            </li>
            <li>
              {outcome.uploadedObjects} encrypted objects uploaded
              {outcome.reusedObjects > 0 ? `, ${outcome.reusedObjects} reused` : ''} ·{' '}
              {formatBytes(outcome.ciphertextBytesUploaded)}.
            </li>
            {status ? (
              <li>
                Storage: {status.objects.primaryStored} on the primary, {status.objects.verified}{' '}
                verified on both.
              </li>
            ) : null}
          </ul>

          <Notice tone="warn" title="Keep your original export for now">
            <p>
              Open the conversation, read a few messages and play an attachment. Only delete your
              original once you have seen the archive work, and never delete the conversation in
              your messaging app because of anything shown here.
            </p>
          </Notice>

          <div className="flex flex-wrap gap-2">
            <Link
              href={`/app/c/${outcome.conversationId}`}
              className="rounded-lg bg-accent-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-600"
            >
              Open the conversation
            </Link>
            <Link
              href={`/app/imports/${outcome.importId}`}
              className="surface rounded-lg border hairline px-3.5 py-2 text-sm"
            >
              Import details
            </Link>
            <Button
              onClick={() => {
                setPhase('choose');
                setPreview(null);
                setFile(null);
                setOutcome(null);
                setStatus(null);
                setProgress(null);
              }}
            >
              Import another
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return null;
}
