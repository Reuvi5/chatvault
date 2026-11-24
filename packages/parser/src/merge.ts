/**
 * Merging a new export into an archive we already hold (plan §3, §8).
 *
 * Exports carry no message identifiers, so the only honest way to merge is to
 * fingerprint messages from their stable fields and align the two lists. Three
 * rules shape everything here:
 *
 *  1. Never silently delete. A newer export that omits older messages does not
 *     mean those messages are gone; we keep them and report the difference.
 *  2. Never silently merge two messages that might be different. Where the
 *     evidence is ambiguous we keep both copies and raise an ambiguity for the
 *     person to look at.
 *  3. Say when history looks discontinuous, instead of implying the archive is
 *     complete.
 */
import type { CanonicalMessage } from './types';

export interface MergeAmbiguity {
  reason: 'repeated_identical' | 'no_overlap' | 'omitted_by_new_export';
  localTs: string;
  sender: string | null;
  count?: number;
  detail: string;
}

export type OverlapMode = 'initial' | 'exact_duplicate' | 'append' | 'prepend' | 'interleaved';

export interface MergeResult {
  merged: CanonicalMessage[];
  added: number;
  duplicatesSkipped: number;
  /** Messages we already hold that this export does not contain. Never removed. */
  missingFromNewExport: number;
  ambiguities: MergeAmbiguity[];
  overlap: { mode: OverlapMode; length: number };
  gapDetected: boolean;
  warnings: string[];
}

/**
 * The fields that identify a message across exports: its wall-clock time, who
 * sent it, what it said and what it attached. Unicode is normalised so that two
 * exports which encode the same text differently still match.
 */
export function fingerprint(message: CanonicalMessage): string {
  const body = message.body
    .normalize('NFC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  const marks = `${message.flags.deleted ? 'd' : ''}${message.flags.mediaOmitted ? 'm' : ''}${
    message.flags.edited ? 'e' : ''
  }`;
  return [
    message.localTs,
    message.kind,
    (message.sender ?? '').normalize('NFC').trim(),
    body,
    (message.attachmentFileName ?? '').normalize('NFC'),
    marks,
  ].join('\u0000');
}

function reseq(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message, index) =>
    message.seq === index ? message : { ...message, seq: index },
  );
}

function slicesMatch(
  a: readonly string[],
  aStart: number,
  b: readonly string[],
  bStart: number,
  length: number,
): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (a[aStart + offset] !== b[bStart + offset]) return false;
  }
  return true;
}

function indexByFingerprint(fingerprints: readonly string[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < fingerprints.length; i += 1) {
    const key = fingerprints[i] as string;
    const bucket = index.get(key);
    if (bucket) bucket.push(i);
    else index.set(key, [i]);
  }
  return index;
}

/** Largest k where the tail of `a` equals the head of `b`. */
function findTailHeadOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const head = b[0] as string;
  const candidates = indexByFingerprint(a).get(head) ?? [];
  for (const start of candidates) {
    const length = a.length - start;
    if (length > b.length) continue;
    if (slicesMatch(a, start, b, 0, length)) return length;
  }
  return 0;
}

function countsOf(fingerprints: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of fingerprints) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** Stable chronological merge: equal timestamps keep existing messages first. */
function mergeChronologically(
  existing: readonly CanonicalMessage[],
  additions: readonly CanonicalMessage[],
): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < additions.length) {
    const left = existing[i] as CanonicalMessage;
    const right = additions[j] as CanonicalMessage;
    if (right.localTs < left.localTs) {
      out.push(right);
      j += 1;
    } else {
      out.push(left);
      i += 1;
    }
  }
  while (i < existing.length) out.push(existing[i++] as CanonicalMessage);
  while (j < additions.length) out.push(additions[j++] as CanonicalMessage);
  return out;
}

export function mergeMessages(
  existing: readonly CanonicalMessage[],
  incoming: readonly CanonicalMessage[],
): MergeResult {
  const ambiguities: MergeAmbiguity[] = [];
  const warnings: string[] = [];

  if (existing.length === 0) {
    return {
      merged: reseq(incoming),
      added: incoming.length,
      duplicatesSkipped: 0,
      missingFromNewExport: 0,
      ambiguities: repeatedIdenticalAmbiguities(incoming),
      overlap: { mode: 'initial', length: 0 },
      gapDetected: false,
      warnings,
    };
  }

  const fpExisting = existing.map(fingerprint);
  const fpIncoming = incoming.map(fingerprint);

  /* Messages we hold that fall inside the new export's range but are absent
     from it. These are never deleted; they are reported. */
  const incomingCounts = countsOf(fpIncoming);
  const firstIncoming = incoming[0]?.localTs ?? null;
  const lastIncoming = incoming.at(-1)?.localTs ?? null;
  let missingFromNewExport = 0;
  if (firstIncoming && lastIncoming) {
    const remaining = new Map(incomingCounts);
    for (let i = 0; i < existing.length; i += 1) {
      const message = existing[i] as CanonicalMessage;
      if (message.localTs < firstIncoming || message.localTs > lastIncoming) continue;
      const key = fpExisting[i] as string;
      const left = remaining.get(key) ?? 0;
      if (left > 0) {
        remaining.set(key, left - 1);
      } else {
        missingFromNewExport += 1;
        if (ambiguities.length < 25) {
          ambiguities.push({
            reason: 'omitted_by_new_export',
            localTs: message.localTs,
            sender: message.sender,
            detail: 'This message is in your archive but not in the new export. ChatVault kept it.',
          });
        }
      }
    }
  }
  if (missingFromNewExport > 0) {
    warnings.push(
      `${String(missingFromNewExport)} message(s) already in your archive are not in this export. They were kept, not removed.`,
    );
  }

  /* Case 1: the new export continues where the archive ends. */
  const appendOverlap = findTailHeadOverlap(fpExisting, fpIncoming);
  if (appendOverlap > 0) {
    if (appendOverlap === fpIncoming.length) {
      return {
        merged: reseq(existing),
        added: 0,
        duplicatesSkipped: incoming.length,
        missingFromNewExport,
        ambiguities,
        overlap: { mode: 'exact_duplicate', length: appendOverlap },
        gapDetected: false,
        warnings: [...warnings, 'Every message in this export was already in your archive.'],
      };
    }
    const tail = incoming.slice(appendOverlap);
    return {
      merged: reseq([...existing, ...tail]),
      added: tail.length,
      duplicatesSkipped: appendOverlap,
      missingFromNewExport,
      ambiguities: [...ambiguities, ...repeatedIdenticalAmbiguities(tail)],
      overlap: { mode: 'append', length: appendOverlap },
      gapDetected: false,
      warnings,
    };
  }

  /* Case 2: the new export reaches further back than the archive does. */
  const prependOverlap = findTailHeadOverlap(fpIncoming, fpExisting);
  if (prependOverlap > 0) {
    const head = incoming.slice(0, incoming.length - prependOverlap);
    return {
      merged: reseq([...head, ...existing]),
      added: head.length,
      duplicatesSkipped: prependOverlap,
      missingFromNewExport,
      ambiguities: [...ambiguities, ...repeatedIdenticalAmbiguities(head)],
      overlap: { mode: 'prepend', length: prependOverlap },
      gapDetected: false,
      warnings: [
        ...warnings,
        'This export contained older messages than your archive had, and they were added before it.',
      ],
    };
  }

  /* Case 3: no contiguous overlap. Fall back to a multiset difference, which
     keeps anything we cannot prove is a duplicate. */
  const available = countsOf(fpExisting);
  const additions: CanonicalMessage[] = [];
  let duplicatesSkipped = 0;
  for (let i = 0; i < incoming.length; i += 1) {
    const key = fpIncoming[i] as string;
    const left = available.get(key) ?? 0;
    if (left > 0) {
      available.set(key, left - 1);
      duplicatesSkipped += 1;
    } else {
      additions.push(incoming[i] as CanonicalMessage);
    }
  }

  const existingLast = existing.at(-1)?.localTs ?? '';
  const existingFirst = existing[0]?.localTs ?? '';
  const gapDetected =
    additions.length > 0 &&
    duplicatesSkipped === 0 &&
    ((firstIncoming !== null && firstIncoming > existingLast) ||
      (lastIncoming !== null && lastIncoming < existingFirst));

  if (additions.length > 0) {
    const first = additions[0] as CanonicalMessage;
    ambiguities.push({
      reason: 'no_overlap',
      localTs: first.localTs,
      sender: first.sender,
      count: additions.length,
      detail:
        'ChatVault could not line this export up against your archive, so messages were matched one by one instead of as a block. Check the preview before importing.',
    });
    warnings.push(
      'This export did not overlap your archive cleanly. Messages were added individually and nothing was removed.',
    );
  }
  if (gapDetected) {
    warnings.push(
      'There is a gap between this export and what your archive already holds, so some messages in between may exist in neither.',
    );
  }

  return {
    merged: reseq(mergeChronologically(existing, additions)),
    added: additions.length,
    duplicatesSkipped,
    missingFromNewExport,
    ambiguities: [...ambiguities, ...repeatedIdenticalAmbiguities(additions)],
    overlap: { mode: 'interleaved', length: duplicatesSkipped },
    gapDetected,
    warnings,
  };
}

/**
 * Messages that are indistinguishable from one another (same minute, same
 * sender, same text) are kept, but we say so: a future merge cannot tell them
 * apart either.
 */
function repeatedIdenticalAmbiguities(messages: readonly CanonicalMessage[]): MergeAmbiguity[] {
  const counts = countsOf(messages.map(fingerprint));
  const out: MergeAmbiguity[] = [];
  for (const message of messages) {
    if (out.length >= 25) break;
    const key = fingerprint(message);
    const count = counts.get(key) ?? 0;
    if (count > 1) {
      counts.set(key, 0);
      out.push({
        reason: 'repeated_identical',
        localTs: message.localTs,
        sender: message.sender,
        count,
        detail: `${String(count)} messages in this export are identical in time, sender and content. All of them were kept.`,
      });
    }
  }
  return out;
}
