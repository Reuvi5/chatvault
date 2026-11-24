/**
 * Matching transcript references to files in the archive, and working out what
 * to call the conversation.
 *
 * Exports reference attachments by file name only, and the name in the
 * transcript does not always match the name in the archive byte-for-byte:
 * invisible marks, different Unicode normalisation and case differences all
 * occur. Anything that still fails to match is reported as missing rather than
 * quietly dropped (plan §3 "indicate coverage and missing assets").
 */
import { baseName } from './archive';

export function normalizeFileName(name: string): string {
  return baseName(name)
    .normalize('NFC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim()
    .toLowerCase();
}

export interface AttachmentMatchResult {
  /** Transcript file name → archive entry name. */
  matched: Map<string, string>;
  /** Referenced by the transcript but not present in the archive. */
  missing: string[];
  /** Present in the archive but never referenced by the transcript. */
  unreferenced: string[];
}

export function matchAttachments(
  referenced: readonly string[],
  available: readonly string[],
): AttachmentMatchResult {
  const byNormalized = new Map<string, string>();
  for (const entry of available) {
    const key = normalizeFileName(entry);
    if (!byNormalized.has(key)) byNormalized.set(key, entry);
  }

  const matched = new Map<string, string>();
  const missing: string[] = [];
  const usedEntries = new Set<string>();

  for (const reference of referenced) {
    const direct = byNormalized.get(normalizeFileName(reference));
    if (direct) {
      matched.set(reference, direct);
      usedEntries.add(direct);
      continue;
    }
    // Some exports write `IMG_0042.JPG` for an entry stored as `IMG-0042.jpg`.
    const loose = normalizeFileName(reference).replace(/[-_\s]/gu, '');
    let fallback: string | undefined;
    for (const [key, entry] of byNormalized) {
      if (key.replace(/[-_\s]/gu, '') === loose) {
        fallback = entry;
        break;
      }
    }
    if (fallback) {
      matched.set(reference, fallback);
      usedEntries.add(fallback);
    } else {
      missing.push(reference);
    }
  }

  const unreferenced = available.filter((entry) => !usedEntries.has(entry));
  return { matched, missing, unreferenced };
}

const TITLE_PATTERNS: RegExp[] = [
  /^whatsapp\s*chat\s*(?:with|-|–|—)\s*(.+)$/iu,
  /^chat\s*(?:with|de|avec|mit|con|com)\s+(.+)$/iu,
  /^(?:whatsapp\s*)?(?:chat|conversation)\s*[-–—]\s*(.+)$/iu,
];

/** Guess a conversation title from the export's own file name. */
export function titleFromFileName(fileName: string): string | null {
  const stem = baseName(fileName)
    .replace(/\.(zip|txt)$/iu, '')
    .trim();
  if (stem === '' || stem === '_chat') return null;
  for (const pattern of TITLE_PATTERNS) {
    const match = pattern.exec(stem);
    const captured = match?.[1]?.trim();
    if (captured) return captured;
  }
  return stem;
}

export interface TitleGuess {
  title: string;
  /** The participant the export belongs to, when it can be worked out. */
  selfName: string | null;
  confidence: 'certain' | 'inferred' | 'assumed';
}

export function inferTitleAndSelf(options: {
  sourceFileName: string;
  participants: readonly string[];
  isGroup: boolean;
}): TitleGuess {
  const fromName = titleFromFileName(options.sourceFileName);
  const participants = options.participants;

  if (!options.isGroup && participants.length === 2 && fromName) {
    const other = participants.find((name) => name.toLowerCase() === fromName.toLowerCase());
    if (other) {
      const self = participants.find((name) => name !== other) ?? null;
      return { title: other, selfName: self, confidence: 'certain' };
    }
  }

  if (fromName) {
    return { title: fromName, selfName: null, confidence: 'inferred' };
  }

  if (participants.length > 0) {
    const shown = participants.slice(0, 3).join(', ');
    const extra = participants.length > 3 ? ` +${String(participants.length - 3)}` : '';
    return {
      title: options.isGroup ? `${shown}${extra}` : participants.join(' & '),
      selfName: null,
      confidence: 'assumed',
    };
  }

  return { title: 'Untitled conversation', selfName: null, confidence: 'assumed' };
}

/** The transcript inside an export archive. */
export function pickTranscriptEntry(entryNames: readonly string[]): {
  name: string | null;
  candidates: string[];
} {
  const candidates = entryNames.filter((name) => /\.txt$/iu.test(name));
  if (candidates.length === 0) return { name: null, candidates };
  const preferred = candidates.find((name) => /^_chat\.txt$/iu.test(baseName(name)));
  if (preferred) return { name: preferred, candidates };
  const chatLike = candidates.find((name) => /chat/iu.test(baseName(name)));
  return { name: chatLike ?? (candidates[0] as string), candidates };
}
