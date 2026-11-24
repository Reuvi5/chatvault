/**
 * Getting your data out (plan §6 "Implement data export").
 *
 * This produces a readable copy of a conversation: a transcript written in the
 * same shape an export arrives in, plus every attachment that was archived, in
 * one ZIP. Two things follow from using the export format rather than a format
 * of our own:
 *
 *  - the file opens in anything that reads a chat export, and
 *  - ChatVault can read its own export back, which the round-trip test checks,
 *    so this doubles as a way to move an archive between accounts.
 *
 * It is a *decrypted* copy, assembled on the device. Nothing is sent anywhere.
 */
import { zipSync } from 'fflate';
import type { ConversationManifest } from '@chatvault/protocol';
import type { CanonicalMessage } from '@chatvault/parser';
import type { ArchiveReader } from './reader';

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

function header(message: CanonicalMessage): string {
  const [date, time] = message.localTs.split('T');
  const [year, month, day] = (date ?? '').split('-');
  return `[${pad(Number(day))}/${pad(Number(month))}/${year ?? ''}, ${time ?? '00:00:00'}]`;
}

/**
 * Render messages as a transcript. The output is deliberately in the same
 * layout the parser reads, so `parseTranscript(renderTranscript(x))` returns the
 * same messages.
 */
export function renderTranscript(messages: readonly CanonicalMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const prefix = header(message);
    const body = message.attachmentFileName
      ? `<attached: ${message.attachmentFileName}>`
      : message.flags.mediaOmitted
        ? message.body || '<Media omitted>'
        : message.body;
    const suffix = message.flags.edited ? ' <This message was edited>' : '';
    lines.push(
      message.sender === null
        ? `${prefix} ${body}${suffix}`
        : `${prefix} ${message.sender}: ${body}${suffix}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function aboutFile(manifest: ConversationManifest, messages: readonly CanonicalMessage[]): string {
  const missing = manifest.attachments.filter((item) => item.missing);
  return [
    `Conversation: ${manifest.title}`,
    `Participants: ${manifest.participants.join(', ')}`,
    `Messages: ${String(messages.length)}`,
    `Covers: ${manifest.firstLocalTs ?? 'unknown'} to ${manifest.lastLocalTs ?? 'unknown'}`,
    `Exported from ChatVault: ${new Date().toISOString()}`,
    '',
    'About the times in _chat.txt',
    '--------------------------',
    'Chat exports do not record a timezone, so these are the wall-clock times',
    `exactly as the original export wrote them. The archive recorded "${manifest.assumedTimeZone}"`,
    'as the timezone to assume when they need to be turned into instants.',
    `Dates were read as ${manifest.dateOrder} (${manifest.dateOrderConfidence}).`,
    '',
    'What is in this file',
    '-------------------',
    `_chat.txt            the transcript, ${String(messages.length)} messages`,
    `attachments          ${String(manifest.attachments.length - missing.length)} files`,
    '',
    missing.length > 0
      ? `${String(missing.length)} attachment(s) were referenced by the conversation but were not in the original export, so they were never archived and are not here:\n${missing
          .slice(0, 50)
          .map((item) => `  - ${item.fileName}`)
          .join('\n')}`
      : 'Every attachment the original export contained is included.',
    '',
    'Coverage notes recorded at import',
    '---------------------------------',
    ...(manifest.warnings.length > 0
      ? manifest.warnings.map((warning) => `- ${warning}`)
      : ['- none']),
    '',
  ].join('\n');
}

export interface ReadableExportProgress {
  phase: 'messages' | 'attachments' | 'packaging';
  done: number;
  total: number;
}

export interface ReadableExport {
  fileName: string;
  bytes: Uint8Array;
  messageCount: number;
  attachmentCount: number;
  skipped: string[];
}

function safeName(value: string): string {
  return (
    value
      .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_')
      .replace(/^\.+/u, '_')
      .slice(0, 120) || 'conversation'
  );
}

/** Build a readable ZIP copy of one conversation, on the device. */
export async function buildReadableExport(options: {
  reader: ArchiveReader;
  manifest: ConversationManifest;
  messages?: readonly CanonicalMessage[];
  onProgress?: (progress: ReadableExportProgress) => void;
  signal?: AbortSignal;
}): Promise<ReadableExport> {
  const { reader, manifest } = options;
  const messages =
    options.messages ??
    (await reader.loadMessages(manifest, {
      onProgress: (done, total) => options.onProgress?.({ phase: 'messages', done, total }),
    }));

  const entries: Record<string, Uint8Array> = {
    '_chat.txt': new TextEncoder().encode(renderTranscript(messages)),
    'ABOUT-THIS-EXPORT.txt': new TextEncoder().encode(aboutFile(manifest, messages)),
  };

  const available = manifest.attachments.filter((item) => !item.missing && item.objectId);
  const skipped: string[] = [];
  let done = 0;
  for (const attachment of available) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    try {
      const loaded = await reader.loadAttachment(attachment);
      entries[safeName(attachment.fileName)] = loaded.bytes;
    } catch (error) {
      skipped.push(
        `${attachment.fileName}: ${error instanceof Error ? error.message : 'unreadable'}`,
      );
    }
    done += 1;
    options.onProgress?.({ phase: 'attachments', done, total: available.length });
  }

  if (skipped.length > 0) {
    entries['COULD-NOT-INCLUDE.txt'] = new TextEncoder().encode(
      `These attachments could not be read when this copy was made:\n${skipped.map((line) => `  - ${line}`).join('\n')}\n`,
    );
  }

  options.onProgress?.({ phase: 'packaging', done: 1, total: 1 });
  return {
    fileName: `ChatVault export - ${safeName(manifest.title)}.zip`,
    bytes: zipSync(entries, { level: 6 }),
    messageCount: messages.length,
    attachmentCount: available.length - skipped.length,
    skipped,
  };
}
