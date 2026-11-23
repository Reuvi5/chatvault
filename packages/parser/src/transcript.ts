/**
 * The transcript line parser.
 *
 * Exports come in two broad shapes:
 *
 *   iOS      [17/11/2026, 9:41:03 AM] Alice: Hello
 *   Android  17/11/2026, 09:41 - Alice: Hello
 *
 * and both appear in many locales, with 12- or 24-hour clocks, with or without
 * seconds, with invisible bidirectional marks sprinkled around, with multi-line
 * bodies, and with system notices that have no sender at all. Everything the
 * parser cannot explain is counted and surfaced rather than dropped.
 */
import { PARSER_VERSION } from '@chatvault/protocol';
import {
  detectDateOrder,
  formatLocalTs,
  parseDateField,
  parseTimeField,
  type DateParts,
  type TimeParts,
} from './dates';
import type {
  CanonicalMessage,
  DateOrder,
  MessageFlags,
  ParseOptions,
  ParsedTranscript,
  ParseWarning,
} from './types';

/** Invisible marks the export inserts around timestamps and media markers. */
const EDGE_BIDI = /^[\u200e\u200f\u202a-\u202e\u2066-\u2069\s]+|[\u200e\u200f\u202a-\u202e\u2066-\u2069\s]+$/gu;

const IOS_WITH_COMMA = /^[\u200e\u200f]?\[([^\],]+),\s*([^\]]+)\]\s*[\u200e\u200f]?([\s\S]*)$/u;
const IOS_WITHOUT_COMMA = /^[\u200e\u200f]?\[([^\s\]]+)\s+([^\]]+)\]\s*[\u200e\u200f]?([\s\S]*)$/u;
const ANDROID =
  /^[\u200e\u200f]?(\d{1,4}[./\-]\d{1,2}[./\-]\d{1,4}),?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s*[APap]\.?\s?[Mm]\.?)?)\s*[-–—]\s+([\s\S]*)$/u;

const SENDER_SPLIT = /^([^:\n]{1,70}):[ \t\u00a0]?([\s\S]*)$/u;

/** Verbs that appear in system notices; used only to break a tie, see below. */
const SYSTEM_VERBS =
  /\b(?:created (?:this )?group|added|removed|left|joined|changed (?:the|this|their)|became an admin|is now an admin|no longer an admin|security code|turned on|turned off|pinned|deleted this group|changed to|started a call|missed (?:voice|video) call|were added|invited)\b/iu;

const EDITED = /[\u200e\u200f]?\s*<[^>]*\b(?:edited|bearbeitet|modifié|editado)\b[^>]*>\s*$/iu;
const DELETED =
  /^(?:this message was deleted|you deleted this message|message deleted|se eliminó este mensaje|ce message a été supprimé)\.?$/iu;
const ATTACHED_IOS = /^<attached:\s*([^>]+)>$/u;
const ATTACHED_ANDROID =
  /^(.+?)\s*\((?:file attached|archivo adjunto|fichier joint|Datei angehängt|arquivo anexado|bestand bijgevoegd)\)$/iu;
const OMITTED =
  /^(?:<media omitted>|<médias omis>|<multimedia omitido>|(?:image|photo|video|audio|sticker|gif|document|contact card|voice message)\s+omitted)\.?$/iu;

interface ProvisionalRecord {
  date: string;
  time: string;
  rest: string;
  lineNumber: number;
}

export interface BodyInterpretation {
  body: string;
  attachmentFileName: string | null;
  flags: MessageFlags;
}

/** Pull media markers and edit/delete notices out of a message body. */
export function interpretBody(input: string): BodyInterpretation {
  const flags: MessageFlags = {};
  let body = input.replace(/\r$/u, '');

  if (EDITED.test(body)) {
    flags.edited = true;
    body = body.replace(EDITED, '');
  }

  const trimmed = body.replace(EDGE_BIDI, '');

  if (DELETED.test(trimmed)) {
    flags.deleted = true;
    return { body: trimmed, attachmentFileName: null, flags };
  }
  if (OMITTED.test(trimmed)) {
    flags.mediaOmitted = true;
    return { body: trimmed, attachmentFileName: null, flags };
  }

  const ios = ATTACHED_IOS.exec(trimmed);
  if (ios?.[1]) {
    return {
      body: '',
      attachmentFileName: ios[1].replace(EDGE_BIDI, ''),
      flags,
    };
  }

  const android = ATTACHED_ANDROID.exec(trimmed);
  if (android?.[1]) {
    const fileName = android[1].replace(EDGE_BIDI, '');
    // Guard against a sentence that merely ends in "(file attached)".
    if (/^[^\s/\\]{1,255}\.[A-Za-z0-9]{1,8}$/u.test(fileName)) {
      return { body: '', attachmentFileName: fileName, flags };
    }
  }

  return { body: trimmed, attachmentFileName: null, flags };
}

function matchPrefix(line: string): { date: string; time: string; rest: string } | null {
  for (const re of [IOS_WITH_COMMA, IOS_WITHOUT_COMMA, ANDROID]) {
    const match = re.exec(line);
    if (!match) continue;
    const [, date, time, rest] = match;
    if (date === undefined || time === undefined) continue;
    // Both fields must be plausible, otherwise this is ordinary text that merely
    // looks like a header (for instance a pasted log line inside a message).
    if (!parseTimeField(time)) continue;
    if (!/^\d/u.test(date.trim())) continue;
    return { date: date.trim(), time: time.trim(), rest: rest ?? '' };
  }
  return null;
}

export function parseTranscript(text: string, options: ParseOptions = {}): ParsedTranscript {
  const maxMessages = options.maxMessages ?? 2_000_000;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\n|\r|\u2028/u);

  /* Pass 1: group physical lines into records. */
  const records: ProvisionalRecord[] = [];
  let unparsedLeadingLines = 0;
  const unparsedSamples: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const prefix = matchPrefix(line);
    if (prefix) {
      if (records.length >= maxMessages) break;
      records.push({ ...prefix, lineNumber: index + 1 });
      continue;
    }
    if (line.trim() === '') {
      const last = records.at(-1);
      if (last) last.rest += '\n';
      continue;
    }
    const last = records.at(-1);
    if (last) {
      last.rest += `\n${line}`;
    } else {
      unparsedLeadingLines += 1;
      if (unparsedSamples.length < 3) unparsedSamples.push(line.slice(0, 120));
    }
  }

  /* Pass 2: decide the date order from every timestamp in the file. */
  const decision = options.dateOrder
    ? ({ order: options.dateOrder, confidence: 'certain', evidence: null } as const)
    : detectDateOrder(records.map((record) => record.date));
  const order: DateOrder = decision.order;

  /* Pass 3: count sender candidates, so a system notice containing a colon can
     be told apart from a real message. A real sender normally speaks more than
     once; a notice like `Alice created group "Trip": ...` does not. */
  const senderCandidateCounts = new Map<string, number>();
  for (const record of records) {
    const split = SENDER_SPLIT.exec(record.rest.replace(EDGE_BIDI, ''));
    const candidate = split?.[1];
    if (candidate) {
      senderCandidateCounts.set(candidate, (senderCandidateCounts.get(candidate) ?? 0) + 1);
    }
  }

  /* Pass 4: build canonical messages. */
  const messages: CanonicalMessage[] = [];
  const participants: string[] = [];
  const participantSet = new Set<string>();
  const referencedFiles: string[] = [];
  const referencedSet = new Set<string>();
  const counts = {
    total: 0,
    messages: 0,
    system: 0,
    withAttachment: 0,
    mediaOmitted: 0,
    edited: 0,
    deleted: 0,
    unparsed: unparsedLeadingLines,
  };
  let minutePrecision = 0;

  for (const record of records) {
    const date: DateParts | null = parseDateField(record.date, order);
    const time: TimeParts | null = parseTimeField(record.time);
    if (!date || !time) {
      counts.unparsed += 1;
      if (unparsedSamples.length < 3) {
        unparsedSamples.push(`${record.date}, ${record.time}`.slice(0, 120));
      }
      continue;
    }
    if (time.precision === 'minute') minutePrecision += 1;

    const rest = record.rest.replace(/\n+$/u, '');
    const cleanRest = rest.replace(/^[\u200e\u200f\u202a-\u202e\u2066-\u2069]+/u, '');
    const split = SENDER_SPLIT.exec(cleanRest);
    const candidate = split?.[1]?.trim();

    let sender: string | null = null;
    let rawBody = cleanRest;
    if (candidate && split) {
      const looksLikeNotice =
        SYSTEM_VERBS.test(candidate) && (senderCandidateCounts.get(split[1] as string) ?? 0) <= 1;
      if (!looksLikeNotice && !candidate.includes('"')) {
        sender = candidate;
        rawBody = split[2] ?? '';
      }
    }

    const interpreted = interpretBody(rawBody);
    const message: CanonicalMessage = {
      seq: messages.length,
      kind: sender ? 'message' : 'system',
      localTs: formatLocalTs(date, time),
      tsPrecision: time.precision,
      sender,
      body: interpreted.body,
      attachmentFileName: interpreted.attachmentFileName,
      flags: interpreted.flags,
    };

    counts.total += 1;
    if (message.kind === 'message') counts.messages += 1;
    else counts.system += 1;
    if (message.flags.edited) counts.edited += 1;
    if (message.flags.deleted) counts.deleted += 1;
    if (message.flags.mediaOmitted) counts.mediaOmitted += 1;
    if (message.attachmentFileName) {
      counts.withAttachment += 1;
      if (!referencedSet.has(message.attachmentFileName)) {
        referencedSet.add(message.attachmentFileName);
        referencedFiles.push(message.attachmentFileName);
      }
    }
    if (sender && !participantSet.has(sender)) {
      participantSet.add(sender);
      participants.push(sender);
    }
    messages.push(message);
  }

  /* Warnings: say what is uncertain instead of implying completeness. */
  const warnings: ParseWarning[] = [];
  if (decision.confidence !== 'certain') {
    warnings.push({
      code: 'date_order_assumed',
      message:
        'Every date in this export could be read either day-first or month-first. ChatVault assumed day-first — check the preview and change it if the dates look wrong.',
    });
  }
  if (counts.mediaOmitted > 0) {
    warnings.push({
      code: 'media_omitted',
      message:
        'This export was created without media, so some messages only have a placeholder where a photo, video or voice note used to be.',
      count: counts.mediaOmitted,
    });
  }
  if (counts.unparsed > 0) {
    warnings.push({
      code: 'unparsed_lines',
      message:
        'Some lines did not look like messages and were skipped. They are usually export headers, but check the samples.',
      count: counts.unparsed,
      samples: unparsedSamples,
    });
  }
  if (minutePrecision > 0 && minutePrecision === counts.total) {
    warnings.push({
      code: 'minute_precision',
      message:
        'This export records times to the minute, not the second. Two messages sent in the same minute cannot be told apart by time alone.',
    });
  }
  if (messages.length === 0) {
    warnings.push({
      code: 'empty_transcript',
      message: 'No messages were found in this file. It may not be a chat export.',
    });
  } else {
    warnings.push({
      code: 'history_may_be_partial',
      message:
        'An export contains only what the app still had on the device. Older messages and older attachments may be missing, and ChatVault cannot tell what was left out.',
    });
  }
  warnings.push({
    code: 'timezone_unknown',
    message:
      'Exports do not record a timezone. Times are stored and shown exactly as they appear in the file.',
  });

  const isGroup =
    participants.length > 2 ||
    messages.some((m) => m.kind === 'system' && /\bgroup\b/iu.test(m.body));

  return {
    messages,
    dateOrder: order,
    dateOrderConfidence: decision.confidence,
    participants,
    isGroup,
    firstLocalTs: messages[0]?.localTs ?? null,
    lastLocalTs: messages.at(-1)?.localTs ?? null,
    referencedFiles,
    counts,
    warnings,
    parserVersion: PARSER_VERSION,
  };
}
