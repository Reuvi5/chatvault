'use client';

/**
 * Rendering an archived attachment.
 *
 * Media is fetched as ciphertext, decrypted in memory and rendered from a blob
 * URL. Nothing is written to disk unless the person downloads it, and the blob
 * URL is revoked when the component goes away.
 */
import { useEffect, useRef, useState } from 'react';
import { formatBytes, type ManifestAttachmentRef } from '@chatvault/protocol';
import { Badge, Button, Spinner } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

export function Attachment({
  attachment,
  compact = false,
}: {
  attachment: ManifestAttachmentRef;
  compact?: boolean;
}) {
  const { reader } = useVault();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const load = async () => {
    if (url || busy || !reader) return;
    setBusy(true);
    setError(null);
    try {
      const { bytes, mimeType } = await reader.loadAttachment(attachment);
      const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      urlRef.current = objectUrl;
      setUrl(objectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That attachment could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  if (attachment.missing) {
    return (
      <div className="sunken rounded-lg border hairline p-2.5 text-xs">
        <Badge tone="warn">Not in the export</Badge>
        <p className="muted mt-1 wrap-anywhere">{attachment.fileName}</p>
        <p className="muted mt-1">
          The transcript refers to this file, but the export did not include it, so it was never
          archived.
        </p>
      </div>
    );
  }

  const label = (
    <span className="wrap-anywhere">
      {attachment.fileName}
      {attachment.byteLength ? (
        <span className="muted"> · {formatBytes(attachment.byteLength)}</span>
      ) : null}
    </span>
  );

  if (!url) {
    return (
      <button
        type="button"
        onClick={() => void load()}
        className="sunken flex w-full items-center gap-2 rounded-lg border hairline p-2.5 text-left text-xs hover:bg-ink-100 dark:hover:bg-ink-700"
      >
        {busy ? <Spinner /> : <span aria-hidden="true">⇣</span>}
        <span className="flex-1">{label}</span>
        {error ? <span className="text-danger-500">{error}</span> : null}
      </button>
    );
  }

  if (attachment.kind === 'image') {
    return (
      <figure className="space-y-1">
        <button type="button" onClick={() => setExpanded(!expanded)} className="block">
          {/* eslint-disable-next-line @next/next/no-img-element -- decrypted blob, not a remote asset */}
          <img
            src={url}
            alt={attachment.fileName}
            className={
              expanded
                ? 'max-h-[80vh] rounded-lg border hairline'
                : compact
                  ? 'max-h-40 rounded-lg border hairline'
                  : 'max-h-72 rounded-lg border hairline'
            }
          />
        </button>
        <figcaption className="muted text-[11px]">{label}</figcaption>
      </figure>
    );
  }

  if (attachment.kind === 'video') {
    return (
      <div className="space-y-1">
        <video src={url} controls className="max-h-72 w-full rounded-lg border hairline" />
        <p className="muted text-[11px]">{label}</p>
      </div>
    );
  }

  if (attachment.kind === 'audio') {
    return (
      <div className="space-y-1">
        <audio src={url} controls className="w-full" />
        <p className="muted text-[11px]">{label}</p>
      </div>
    );
  }

  return (
    <div className="sunken space-y-2 rounded-lg border hairline p-2.5 text-xs">
      <p>{label}</p>
      <Button onClick={() => window.open(url, '_blank', 'noopener')}>Open</Button>
      <a
        href={url}
        download={attachment.fileName}
        className="ml-2 underline"
      >
        Download
      </a>
    </div>
  );
}
