import { describe, expect, it } from 'vitest';
import {
  dateComponents,
  detectDateOrder,
  formatLocalTs,
  parseDateField,
  parseTimeField,
  timeZoneOffsetMs,
  wallClockToEpochMs,
} from './dates';

describe('date order inference', () => {
  it('is certain when a day above 12 appears first', () => {
    const decision = detectDateOrder(['03/04/2026', '17/11/2026']);
    expect(decision).toMatchObject({ order: 'dmy', confidence: 'certain' });
  });

  it('is certain when a day above 12 appears second', () => {
    const decision = detectDateOrder(['3/4/26', '11/17/26']);
    expect(decision).toMatchObject({ order: 'mdy', confidence: 'certain' });
  });

  it('admits when the file is genuinely ambiguous', () => {
    const decision = detectDateOrder(['03/04/2026', '05/06/2026', '07/08/2026']);
    expect(decision).toMatchObject({ order: 'dmy', confidence: 'assumed', evidence: null });
  });

  it('recognises a year-first format', () => {
    expect(detectDateOrder(['2026-11-17', '2026-11-18'])).toMatchObject({
      order: 'ymd',
      confidence: 'inferred',
    });
  });

  it('falls back to day-first, flagged as assumed, when a file contradicts itself', () => {
    expect(detectDateOrder(['17/11/2026', '11/17/2026'])).toMatchObject({
      order: 'dmy',
      confidence: 'assumed',
    });
  });

  it('ignores fields that are not dates', () => {
    expect(dateComponents('not a date')).toBeNull();
    expect(dateComponents('17/11/2026')).toEqual([17, 11, 2026]);
  });
});

describe('date parsing', () => {
  it('reads each supported order', () => {
    expect(parseDateField('17/11/2026', 'dmy')).toEqual({ year: 2026, month: 11, day: 17 });
    expect(parseDateField('11/17/2026', 'mdy')).toEqual({ year: 2026, month: 11, day: 17 });
    expect(parseDateField('2026-11-17', 'ymd')).toEqual({ year: 2026, month: 11, day: 17 });
    expect(parseDateField('17.11.26', 'dmy')).toEqual({ year: 2026, month: 11, day: 17 });
  });

  it('expands two-digit years toward this century', () => {
    expect(parseDateField('01/02/09', 'dmy')?.year).toBe(2009);
    expect(parseDateField('01/02/99', 'dmy')?.year).toBe(1999);
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseDateField('31/02/2026', 'dmy')).toBeNull();
    expect(parseDateField('32/01/2026', 'dmy')).toBeNull();
    expect(parseDateField('17/13/2026', 'dmy')).toBeNull();
  });

  it('accepts a leap day only in a leap year', () => {
    expect(parseDateField('29/02/2024', 'dmy')).not.toBeNull();
    expect(parseDateField('29/02/2026', 'dmy')).toBeNull();
  });
});

describe('time parsing', () => {
  it('reads 24-hour times with and without seconds', () => {
    expect(parseTimeField('09:41')).toEqual({ hour: 9, minute: 41, second: 0, precision: 'minute' });
    expect(parseTimeField('21:41:07')).toEqual({
      hour: 21,
      minute: 41,
      second: 7,
      precision: 'second',
    });
  });

  it('reads 12-hour times, including the midnight and noon edge cases', () => {
    expect(parseTimeField('12:00 AM')?.hour).toBe(0);
    expect(parseTimeField('12:00 PM')?.hour).toBe(12);
    expect(parseTimeField('1:05 pm')?.hour).toBe(13);
    expect(parseTimeField('11:59 p.m.')?.hour).toBe(23);
  });

  it('tolerates the narrow no-break space exports use before AM/PM', () => {
    expect(parseTimeField('9:41:03\u202fAM')).toEqual({
      hour: 9,
      minute: 41,
      second: 3,
      precision: 'second',
    });
    expect(parseTimeField('9:41\u00a0PM')?.hour).toBe(21);
  });

  it('rejects nonsense', () => {
    expect(parseTimeField('25:00')).toBeNull();
    expect(parseTimeField('09:70')).toBeNull();
    expect(parseTimeField('13:00 PM')).toBeNull();
    expect(parseTimeField('nope')).toBeNull();
  });
});

describe('canonical timestamps', () => {
  it('formats to a sortable, zone-free string', () => {
    expect(
      formatLocalTs({ year: 2026, month: 3, day: 7 }, { hour: 9, minute: 5, second: 0, precision: 'minute' }),
    ).toBe('2026-03-07T09:05:00');
  });

  it('sorts lexicographically in chronological order', () => {
    const values = ['2026-03-07T09:05:00', '2026-03-07T10:00:00', '2025-12-31T23:59:59'];
    expect([...values].sort()).toEqual([
      '2025-12-31T23:59:59',
      '2026-03-07T09:05:00',
      '2026-03-07T10:00:00',
    ]);
  });
});

describe('timezone handling', () => {
  it('treats UTC as the identity', () => {
    expect(wallClockToEpochMs('2026-03-07T09:05:00', 'UTC')).toBe(
      Date.parse('2026-03-07T09:05:00Z'),
    );
  });

  it('applies a fixed offset correctly', () => {
    const epoch = wallClockToEpochMs('2026-01-15T12:00:00', 'America/New_York');
    expect(new Date(epoch).toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('applies the right offset on each side of a daylight-saving change', () => {
    const before = wallClockToEpochMs('2026-03-07T12:00:00', 'America/New_York');
    const after = wallClockToEpochMs('2026-03-09T12:00:00', 'America/New_York');
    expect(new Date(before).toISOString()).toBe('2026-03-07T17:00:00.000Z');
    expect(new Date(after).toISOString()).toBe('2026-03-09T16:00:00.000Z');
  });

  it('shifts a non-existent local time forward past the gap instead of throwing', () => {
    // 02:30 on the spring-forward morning never happens in New York.
    const epoch = wallClockToEpochMs('2026-03-08T02:30:00', 'America/New_York');
    expect(new Date(epoch).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('picks the first of two possible instants when a local time repeats', () => {
    // 01:30 happens twice on the autumn fall-back morning in New York.
    const epoch = wallClockToEpochMs('2026-11-01T01:30:00', 'America/New_York');
    expect(new Date(epoch).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('reports the offset a zone had at an instant', () => {
    expect(timeZoneOffsetMs(Date.parse('2026-01-15T17:00:00Z'), 'America/New_York')).toBe(
      -5 * 3_600_000,
    );
    expect(timeZoneOffsetMs(Date.parse('2026-07-15T16:00:00Z'), 'America/New_York')).toBe(
      -4 * 3_600_000,
    );
  });

  it('falls back to UTC for an unknown zone rather than failing an import', () => {
    expect(wallClockToEpochMs('2026-03-07T09:05:00', 'Mars/Olympus_Mons')).toBe(
      Date.parse('2026-03-07T09:05:00Z'),
    );
  });
});
