/**
 * The canonical message model.
 *
 * Exports are plain text with no identifiers, no timezone and no schema, so the
 * parser's job is to turn them into something stable enough to merge against a
 * later export of the same conversation (plan §8).
 */

export type MessageKind = 'message' | 'system';

export type DateOrder = 'dmy' | 'mdy' | 'ymd';
export type Confidence = 'certain' | 'inferred' | 'assumed';

export interface MessageFlags {
  /** The export marked this message as edited after it was sent. */
  edited?: true;
  /** The export recorded that the message was deleted for everyone. */
  deleted?: true;
  /** The export was created without media, so only a placeholder exists. */
  mediaOmitted?: true;
  /** A line the parser could not fully understand; `raw` is kept for review. */
  parseIssue?: true;
}

export interface CanonicalMessage {
  /** Position in the canonical list. Not stable across imports; never a key. */
  seq: number;
  kind: MessageKind;
  /**
   * Wall-clock time exactly as the export wrote it, normalised to
   * `YYYY-MM-DDTHH:MM:SS`. Exports carry no timezone, so this is not an instant.
   */
  localTs: string;
  /** Whether the export gave seconds or only minutes. */
  tsPrecision: 'minute' | 'second';
  /** Display name as written in the export; null for system notices. */
  sender: string | null;
  body: string;
  /** File name the message referenced, if any. */
  attachmentFileName: string | null;
  flags: MessageFlags;
  /** Original line, kept only when the parser flagged a problem. */
  raw?: string;
}

export interface ParseWarning {
  code:
    | 'date_order_assumed'
    | 'media_omitted'
    | 'attachments_missing'
    | 'attachments_unreferenced'
    | 'unparsed_lines'
    | 'minute_precision'
    | 'history_may_be_partial'
    | 'multiple_transcripts'
    | 'empty_transcript'
    | 'self_name_unknown'
    | 'timezone_unknown';
  message: string;
  count?: number;
  samples?: string[];
}

export interface ParsedTranscript {
  messages: CanonicalMessage[];
  dateOrder: DateOrder;
  dateOrderConfidence: Confidence;
  /** Distinct sender names, in first-seen order. */
  participants: string[];
  isGroup: boolean;
  firstLocalTs: string | null;
  lastLocalTs: string | null;
  /** File names referenced by the transcript, in first-seen order. */
  referencedFiles: string[];
  counts: {
    total: number;
    messages: number;
    system: number;
    withAttachment: number;
    mediaOmitted: number;
    edited: number;
    deleted: number;
    unparsed: number;
  };
  warnings: ParseWarning[];
  parserVersion: number;
}

export interface ParseOptions {
  /** Force a date order instead of inferring one (set from the preview screen). */
  dateOrder?: DateOrder;
  /** Timezone assumed when turning wall-clock stamps into instants. */
  assumedTimeZone?: string;
  /** Hard cap on messages, to keep a hostile file from exhausting memory. */
  maxMessages?: number;
}
