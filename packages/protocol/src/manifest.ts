/**
 * The conversation manifest.
 *
 * This document is the only place where human-meaningful information about a
 * conversation lives: its title, participants, which encrypted page holds which
 * messages, and which attachment maps to which encrypted object. It is encrypted
 * on the device before upload and the server stores it as an opaque blob
 * (plan §5 "Database design note").
 */
import { MANIFEST_VERSION } from './constants';

export interface ManifestPageRef {
  /** Stable page identifier inside this conversation. */
  pageId: string;
  /** Encrypted object holding the JSON array of messages. */
  objectId: string;
  messageCount: number;
  /** Wall-clock bounds, as written in the export (no timezone is available). */
  firstLocalTs: string;
  lastLocalTs: string;
  /** SHA-256 of the plaintext page JSON: detects a rolled-back or swapped page. */
  plaintextSha256: string;
  ciphertextBytes: number;
}

export interface ManifestAttachmentRef {
  /** File name exactly as it appeared in the export. */
  fileName: string;
  objectId: string | null;
  /** Null when the export referenced a file it did not contain. */
  byteLength: number | null;
  mimeType: string | null;
  plaintextSha256: string | null;
  ciphertextBytes: number;
  /** True when the transcript referenced this file but the archive lacked it. */
  missing: boolean;
  kind: 'image' | 'video' | 'audio' | 'document' | 'unknown';
}

export interface ManifestImportRecord {
  importId: string;
  importedAtMs: number;
  parserVersion: number;
  /** SHA-256 of the original export file, kept inside the encrypted manifest only. */
  sourceSha256: string;
  sourceFileName: string;
  sourceBytes: number;
  messagesAdded: number;
  duplicatesSkipped: number;
  ambiguities: number;
  warnings: string[];
}

export interface ConversationManifest {
  v: typeof MANIFEST_VERSION | number;
  conversationId: string;
  /** Monotonic; every re-import writes a new version. */
  manifestVersion: number;
  title: string;
  isGroup: boolean;
  participants: string[];
  /** The export's own idea of "me", when it can be determined. */
  selfName: string | null;
  messageCount: number;
  firstLocalTs: string | null;
  lastLocalTs: string | null;
  /** Timezone the client assumed when turning wall-clock stamps into instants. */
  assumedTimeZone: string;
  dateOrder: 'dmy' | 'mdy' | 'ymd';
  dateOrderConfidence: 'certain' | 'inferred' | 'assumed';
  pages: ManifestPageRef[];
  attachments: ManifestAttachmentRef[];
  imports: ManifestImportRecord[];
  /** Coverage notes shown in the UI instead of claiming completeness (plan §3). */
  warnings: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

export function emptyManifest(
  conversationId: string,
  assumedTimeZone: string,
  nowMs: number,
): ConversationManifest {
  return {
    v: MANIFEST_VERSION,
    conversationId,
    manifestVersion: 0,
    title: '',
    isGroup: false,
    participants: [],
    selfName: null,
    messageCount: 0,
    firstLocalTs: null,
    lastLocalTs: null,
    assumedTimeZone,
    dateOrder: 'dmy',
    dateOrderConfidence: 'assumed',
    pages: [],
    attachments: [],
    imports: [],
    warnings: [],
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** Total ciphertext bytes a manifest accounts for, used for usage reconciliation. */
export function manifestCiphertextBytes(manifest: ConversationManifest): number {
  const pages = manifest.pages.reduce((sum, page) => sum + page.ciphertextBytes, 0);
  const media = manifest.attachments.reduce((sum, item) => sum + item.ciphertextBytes, 0);
  return pages + media;
}

export function attachmentKindFor(fileName: string): ManifestAttachmentRef['kind'] {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'avif'].includes(ext)) {
    return 'image';
  }
  if (['mp4', 'mov', '3gp', 'mkv', 'avi', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['opus', 'ogg', 'oga', 'mp3', 'm4a', 'aac', 'wav', 'amr', 'flac'].includes(ext)) {
    return 'audio';
  }
  if (
    ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'zip', 'vcf'].includes(
      ext,
    )
  ) {
    return 'document';
  }
  return 'unknown';
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  amr: 'audio/amr',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  vcf: 'text/vcard',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeTypeFor(fileName: string): string | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}
