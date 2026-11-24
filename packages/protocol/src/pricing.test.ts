import { describe, expect, it } from 'vitest';
import {
  byteHours,
  formatBytes,
  gbMonthsFromByteHours,
  hoursInMonth,
  monthKey,
  quoteMonth,
  rawTwoCopyCostUsd,
  toCents,
  usdFromGbMonths,
} from './pricing';
import { BYTES_PER_GB } from './constants';

const GB = BYTES_PER_GB;
const HOUR = 3_600_000;

describe('calendar helpers', () => {
  it('uses the real length of each month', () => {
    expect(hoursInMonth(Date.UTC(2026, 10, 17))).toBe(720); // November: 30 days
    expect(hoursInMonth(Date.UTC(2026, 0, 2))).toBe(744); // January: 31 days
    expect(hoursInMonth(Date.UTC(2024, 1, 2))).toBe(696); // February 2024: leap
  });

  it('labels periods as YYYY-MM', () => {
    expect(monthKey(Date.UTC(2026, 10, 17))).toBe('2026-11');
    expect(monthKey(Date.UTC(2026, 0, 1))).toBe('2026-01');
  });
});

describe('byteHours', () => {
  it('integrates a step function and holds each value until the next sample', () => {
    const start = Date.UTC(2026, 10, 1);
    const result = byteHours(
      [
        { atMs: start, logicalBytes: 0 },
        { atMs: start + 10 * HOUR, logicalBytes: 100 * GB },
      ],
      { startMs: start, endMs: start + 20 * HOUR },
    );
    // 10h at 0 bytes, then 10h at 100 GB.
    expect(result).toBe(100 * GB * 10);
  });

  it('carries in bytes that already existed when the period opened', () => {
    const start = Date.UTC(2026, 10, 1);
    const result = byteHours([], { startMs: start, endMs: start + 5 * HOUR }, 2 * GB);
    expect(result).toBe(2 * GB * 5);
  });

  it('ignores samples outside the period but honours the latest one before it', () => {
    const start = Date.UTC(2026, 10, 10);
    const result = byteHours(
      [
        { atMs: start - 100 * HOUR, logicalBytes: 7 * GB },
        { atMs: start + 1000 * HOUR, logicalBytes: 999 * GB },
      ],
      { startMs: start, endMs: start + 2 * HOUR },
    );
    expect(result).toBe(7 * GB * 2);
  });

  it('never bills negative storage', () => {
    const start = Date.UTC(2026, 10, 1);
    expect(
      byteHours([{ atMs: start, logicalBytes: -5 }], { startMs: start, endMs: start + HOUR }),
    ).toBe(0);
  });
});

describe('agreed price: $0.05 per logical GB-month', () => {
  const cases: Array<[number, number]> = [
    [10, 0.5],
    [50, 2.5],
    [100, 5],
    [250, 12.5],
    [500, 25],
    [1000, 50],
  ];

  it.each(cases)('%i GB stored for a full month bills $%s', (gb, expected) => {
    const month = Date.UTC(2026, 10, 1);
    const hours = hoursInMonth(month);
    const usd = usdFromGbMonths(gbMonthsFromByteHours(gb * GB * hours, hours));
    expect(usd).toBeCloseTo(expected, 10);
  });

  it('prorates a half-month of storage to half the price', () => {
    const start = Date.UTC(2026, 10, 1);
    const hours = hoursInMonth(start);
    const quote = quoteMonth([{ atMs: start, logicalBytes: 100 * GB }], start + (hours / 2) * HOUR);
    expect(quote.accruedUsd).toBeCloseTo(2.5, 10);
    expect(quote.projectedUsd).toBeCloseTo(5, 10);
  });

  it('bills once per logical byte, not once per replica', () => {
    const start = Date.UTC(2026, 10, 1);
    const hours = hoursInMonth(start);
    const quote = quoteMonth([{ atMs: start, logicalBytes: 100 * GB }], start + hours * HOUR);
    // Two independent encrypted copies exist, but the customer sees one copy.
    expect(quote.projectedUsd).toBeCloseTo(5, 10);
    expect(rawTwoCopyCostUsd(100 * GB)).toBeCloseTo(2.195, 10);
  });
});

describe('policy flags that the plan leaves undecided', () => {
  const start = Date.UTC(2026, 10, 1);
  const hours = hoursInMonth(start);

  it('does not enforce a minimum charge by default (plan §14.1)', () => {
    const quote = quoteMonth([{ atMs: start, logicalBytes: 1 * GB }], start + hours * HOUR);
    expect(quote.projectedUsd).toBeCloseTo(0.05, 10);
    expect(quote.projectedUsdWithMinimum).toBeCloseTo(0.05, 10);
  });

  it('applies a minimum only when one is configured', () => {
    const quote = quoteMonth([{ atMs: start, logicalBytes: 1 * GB }], start + hours * HOUR, {
      policy: { pricePerGbMonth: 0.05, freeAllowanceBytes: 0, minimumCents: 299 },
    });
    expect(quote.projectedUsdWithMinimum).toBeCloseTo(2.99, 10);
  });

  it('subtracts a free allowance when one is configured', () => {
    const quote = quoteMonth([{ atMs: start, logicalBytes: 15 * GB }], start + hours * HOUR, {
      policy: { pricePerGbMonth: 0.05, freeAllowanceBytes: 10 * GB, minimumCents: 0 },
    });
    expect(quote.projectedUsd).toBeCloseTo(0.25, 10);
  });
});

describe('presentation', () => {
  it('rounds to whole cents, half up', () => {
    expect(toCents(0.005)).toBe(1);
    expect(toCents(2.994)).toBe(299);
    expect(toCents(-1)).toBe(0);
  });

  it('formats bytes in decimal units to match the pricing definition', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.00 kB');
    expect(formatBytes(GB)).toBe('1.00 GB');
    expect(formatBytes(250 * GB)).toBe('250.0 GB');
  });
});
