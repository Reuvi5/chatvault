/**
 * Date and time handling for exported transcripts.
 *
 * Two problems the export format creates for us:
 *
 *  1. `03/04/2026` is ambiguous. We scan the whole file for a value that can
 *     only be a day (> 12) and report how confident the conclusion is, rather
 *     than guessing silently (plan §8 "explicit parser confidence").
 *  2. There is no timezone anywhere in an export. We keep the wall-clock text as
 *     the archive's truth and convert to an instant only against a timezone the
 *     person chooses, which is recorded in the manifest.
 */
import type { Confidence, DateOrder } from './types';

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface TimeParts {
  hour: number;
  minute: number;
  second: number;
  precision: 'minute' | 'second';
}

const DATE_RE = /^(\d{1,4})[./\-](\d{1,2})[./\-](\d{1,4})$/u;
const TIME_RE =
  /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s*([APap])\.?\s?[Mm]\.?)?$/u;

/** Split a date field into its three numeric components, or null. */
export function dateComponents(text: string): [number, number, number] | null {
  const match = DATE_RE.exec(text.trim());
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return [a, b, c];
}

export interface DateOrderDecision {
  order: DateOrder;
  confidence: Confidence;
  /** The sample that settled it, for the preview screen. */
  evidence: string | null;
}

/**
 * Infer the component order from every date in the file.
 *
 * A first component above 12 proves day-first; a second component above 12
 * proves month-first; a four-digit first component proves year-first. Without
 * such evidence the order is genuinely unknowable, so we assume day-first (the
 * more common export locale) and say so.
 */
export function detectDateOrder(samples: readonly string[]): DateOrderDecision {
  let sawDayFirstEvidence: string | null = null;
  let sawMonthFirstEvidence: string | null = null;
  let sawYearFirst: string | null = null;

  for (const sample of samples) {
    const parts = dateComponents(sample);
    if (!parts) continue;
    const [a, b] = parts;
    if (a > 1000) {
      sawYearFirst ??= sample;
      continue;
    }
    if (a > 12 && a <= 31) sawDayFirstEvidence ??= sample;
    if (b > 12 && b <= 31) sawMonthFirstEvidence ??= sample;
  }

  if (sawYearFirst && !sawDayFirstEvidence && !sawMonthFirstEvidence) {
    return { order: 'ymd', confidence: 'inferred', evidence: sawYearFirst };
  }
  if (sawDayFirstEvidence && sawMonthFirstEvidence) {
    // The file disagrees with itself; day-first is the safer reading because it
    // is the dominant export locale, but flag it as merely assumed.
    return { order: 'dmy', confidence: 'assumed', evidence: sawDayFirstEvidence };
  }
  if (sawDayFirstEvidence) return { order: 'dmy', confidence: 'certain', evidence: sawDayFirstEvidence };
  if (sawMonthFirstEvidence) {
    return { order: 'mdy', confidence: 'certain', evidence: sawMonthFirstEvidence };
  }
  return { order: 'dmy', confidence: 'assumed', evidence: null };
}

function expandYear(value: number): number {
  if (value >= 1000) return value;
  // Exports only exist from 2009 onward; treat 80-99 as 19xx for safety.
  return value >= 80 ? 1900 + value : 2000 + value;
}

export function parseDateField(text: string, order: DateOrder): DateParts | null {
  const parts = dateComponents(text);
  if (!parts) return null;
  const [a, b, c] = parts;
  let year: number;
  let month: number;
  let day: number;
  switch (order) {
    case 'dmy':
      day = a;
      month = b;
      year = expandYear(c);
      break;
    case 'mdy':
      month = a;
      day = b;
      year = expandYear(c);
      break;
    case 'ymd':
      year = expandYear(a);
      month = b;
      day = c;
      break;
  }
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1990 || year > 2200) return null;
  if (day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseTimeField(text: string): TimeParts | null {
  const match = TIME_RE.exec(text.trim().replace(/[\u00a0\u202f\u200e\u200f]/gu, ' ').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const meridiem = match[4]?.toLowerCase();

  if (meridiem === 'a') {
    if (hour === 12) hour = 0;
    else if (hour > 12) return null;
  } else if (meridiem === 'p') {
    if (hour !== 12) hour += 12;
    if (hour > 23) return null;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    hour,
    minute,
    second,
    precision: match[3] === undefined ? 'minute' : 'second',
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function formatLocalTs(date: DateParts, time: TimeParts): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}T${pad(time.hour)}:${pad(
    time.minute,
  )}:${pad(time.second)}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset in milliseconds that `timeZone` was at the given instant. */
export function timeZoneOffsetMs(epochMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    fields.year ?? 1970,
    (fields.month ?? 1) - 1,
    fields.day ?? 1,
    fields.hour ?? 0,
    fields.minute ?? 0,
    fields.second ?? 0,
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Interpret a wall-clock string in a timezone.
 *
 * Two passes, because the offset depends on the instant we are trying to find.
 * On a spring-forward gap the result lands just after the gap; on a
 * fall-back repeat it picks the first of the two possible instants. Both are
 * deterministic, which is what matters for a stable archive.
 */
export function wallClockToEpochMs(localTs: string, timeZone = 'UTC'): number {
  const naive = Date.parse(`${localTs}Z`);
  if (Number.isNaN(naive)) throw new Error(`Unreadable timestamp: ${localTs}`);
  if (timeZone === 'UTC' || !isValidTimeZone(timeZone)) return naive;

  const firstOffset = timeZoneOffsetMs(naive, timeZone);
  const firstGuess = naive - firstOffset;
  const secondOffset = timeZoneOffsetMs(firstGuess, timeZone);
  if (secondOffset === firstOffset) return firstGuess;

  // The offset changed between the two probes, so we are at a transition.
  const refined = naive - secondOffset;
  if (timeZoneOffsetMs(refined, timeZone) === secondOffset) return refined;

  // The wall-clock time does not exist (a spring-forward gap). Shift forward
  // past the gap, which is the convention date libraries use.
  return firstGuess;
}

/** `YYYY-MM-DD` part of a canonical local timestamp. */
export function localDate(localTs: string): string {
  return localTs.slice(0, 10);
}
