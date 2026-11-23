import { describe, expect, it } from 'vitest';
import { fingerprint, mergeMessages } from './merge';
import type { CanonicalMessage } from './types';
import { parseTranscript } from './transcript';

let counter = 0;
function message(localTs: string, sender: string, body: string): CanonicalMessage {
  return {
    seq: counter++,
    kind: 'message',
    localTs,
    tsPrecision: 'second',
    sender,
    body,
    attachmentFileName: null,
    flags: {},
  };
}

const a = () => message('2026-03-07T09:00:00', 'Dana', 'one');
const b = () => message('2026-03-07T10:00:00', 'Sam', 'two');
const c = () => message('2026-03-07T11:00:00', 'Dana', 'three');
const d = () => message('2026-03-08T09:00:00', 'Sam', 'four');

describe('fingerprints', () => {
  it('ignore sequence numbers and invisible marks but not real content', () => {
    expect(fingerprint(a())).toBe(fingerprint(a()));
    expect(fingerprint({ ...a(), seq: 999 })).toBe(fingerprint(a()));
    expect(fingerprint({ ...a(), body: '\u200eone' })).toBe(fingerprint(a()));
    expect(fingerprint({ ...a(), body: 'ONE' })).not.toBe(fingerprint(a()));
    expect(fingerprint({ ...a(), sender: 'Sam' })).not.toBe(fingerprint(a()));
  });

  it('treat differently normalised Unicode as the same text', () => {
    const composed = { ...a(), body: 'café' };
    const decomposed = { ...a(), body: 'café' };
    expect(fingerprint(composed)).toBe(fingerprint(decomposed));
  });

  it('distinguish an edited message from the original', () => {
    expect(fingerprint({ ...a(), flags: { edited: true } })).not.toBe(fingerprint(a()));
  });
});

describe('first import', () => {
  it('takes everything', () => {
    const result = mergeMessages([], [a(), b()]);
    expect(result.added).toBe(2);
    expect(result.overlap.mode).toBe('initial');
    expect(result.merged.map((m) => m.seq)).toEqual([0, 1]);
  });
});

describe('re-importing the same conversation', () => {
  it('adds nothing when the export is identical', () => {
    const existing = [a(), b(), c()];
    const result = mergeMessages(existing, [a(), b(), c()]);
    expect(result.added).toBe(0);
    expect(result.duplicatesSkipped).toBe(3);
    expect(result.overlap.mode).toBe('exact_duplicate');
    expect(result.merged).toHaveLength(3);
  });

  it('appends only the new tail when the export continues the conversation', () => {
    const result = mergeMessages([a(), b()], [b(), c(), d()]);
    expect(result.overlap).toEqual({ mode: 'append', length: 1 });
    expect(result.added).toBe(2);
    expect(result.merged.map((m) => m.body)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('prepends older history when the new export reaches further back', () => {
    const result = mergeMessages([c(), d()], [a(), b(), c(), d()]);
    expect(result.overlap.mode).toBe('prepend');
    expect(result.added).toBe(2);
    expect(result.merged.map((m) => m.body)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('keeps messages the new export omits, and says how many', () => {
    const existing = [a(), b(), c()];
    const result = mergeMessages(existing, [a(), c()]);
    expect(result.merged).toHaveLength(3);
    expect(result.missingFromNewExport).toBe(1);
    expect(result.ambiguities.some((x) => x.reason === 'omitted_by_new_export')).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/kept, not removed/i);
  });

  it('falls back to message-by-message matching when nothing lines up', () => {
    const result = mergeMessages([a(), c()], [b(), d()]);
    expect(result.overlap.mode).toBe('interleaved');
    expect(result.added).toBe(2);
    expect(result.merged.map((m) => m.body)).toEqual(['one', 'two', 'three', 'four']);
    expect(result.ambiguities.some((x) => x.reason === 'no_overlap')).toBe(true);
  });

  it('reports a gap when the two exports do not meet', () => {
    const result = mergeMessages([a()], [d()]);
    expect(result.gapDetected).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/gap/i);
  });

  it('does not report a gap when the exports overlap', () => {
    const result = mergeMessages([a(), b()], [b(), c()]);
    expect(result.gapDetected).toBe(false);
  });
});

describe('messages that cannot be told apart', () => {
  it('keeps them all and raises an ambiguity', () => {
    const twin = () => message('2026-03-07T12:00:00', 'Sam', 'ok');
    const result = mergeMessages([], [twin(), twin()]);
    expect(result.merged).toHaveLength(2);
    const ambiguity = result.ambiguities.find((x) => x.reason === 'repeated_identical');
    expect(ambiguity?.count).toBe(2);
  });

  it('does not duplicate them on a re-import', () => {
    const twin = () => message('2026-03-07T12:00:00', 'Sam', 'ok');
    const existing = [a(), twin(), twin()];
    const result = mergeMessages(existing, [a(), twin(), twin()]);
    expect(result.added).toBe(0);
    expect(result.merged).toHaveLength(3);
  });

  it('adds a third copy only when the export really contains three', () => {
    const twin = () => message('2026-03-07T12:00:00', 'Sam', 'ok');
    const result = mergeMessages([twin(), twin()], [twin(), twin(), twin()]);
    expect(result.merged).toHaveLength(3);
    expect(result.added).toBe(1);
  });
});

describe('merging parsed exports end to end', () => {
  const day1 = [
    '17/11/2026, 09:41 - Dana: morning',
    '17/11/2026, 09:42 - Sam: morning!',
    '17/11/2026, 09:43 - Dana: coffee?',
  ].join('\n');
  const day1and2 = [
    day1,
    '18/11/2026, 08:15 - Sam: same time today?',
    '18/11/2026, 08:16 - Dana: yes',
  ].join('\n');

  it('imports, re-imports and extends without ever losing a message', () => {
    const first = parseTranscript(day1).messages;
    const second = parseTranscript(day1and2).messages;

    const initial = mergeMessages([], first);
    expect(initial.added).toBe(3);

    const unchanged = mergeMessages(initial.merged, first);
    expect(unchanged.added).toBe(0);

    const extended = mergeMessages(initial.merged, second);
    expect(extended.added).toBe(2);
    expect(extended.merged).toHaveLength(5);
    expect(extended.merged.at(-1)?.body).toBe('yes');
    expect(extended.merged.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps the archive chronological after an awkward merge', () => {
    const merged = mergeMessages(parseTranscript(day1).messages, [
      message('2026-11-16T22:00:00', 'Sam', 'last night'),
      message('2026-11-17T09:41:30', 'Sam', 'in between'),
    ]).merged;
    const stamps = merged.map((m) => m.localTs);
    expect([...stamps].sort()).toEqual(stamps);
  });
});
