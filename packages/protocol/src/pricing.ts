/**
 * Usage metering and pricing math (plan §9).
 *
 * Billing rules implemented here:
 *  - Customers are billed once per *logical* stored byte, never once per replica.
 *  - A GB is 1,000,000,000 bytes.
 *  - Usage accrues over time: we integrate a step function of "logical bytes
 *    stored" over the billing period to get byte-hours, then convert to
 *    GB-months using the real number of hours in that calendar month.
 *  - Minimum charges and free allowances are *configurable and default to off*,
 *    because plan §9/§14.1 records the $2.99 floor as a recommendation that has
 *    not been approved.
 */
import { BYTES_PER_GB, PRICE_USD_PER_GB_MONTH } from './constants';

export interface UsageSample {
  /** Unix epoch milliseconds at which this measurement was taken. */
  atMs: number;
  /** Logical (single-copy) ciphertext bytes stored for the account. */
  logicalBytes: number;
}

export interface BillingPeriod {
  startMs: number;
  endMs: number;
}

export interface BillingPolicy {
  /** USD per logical GB-month. */
  pricePerGbMonth: number;
  /** Bytes that are not billed at all (0 = no free allowance). */
  freeAllowanceBytes: number;
  /** Minimum invoice in cents (0 = not enforced). */
  minimumCents: number;
}

export const DEFAULT_BILLING_POLICY: BillingPolicy = {
  pricePerGbMonth: PRICE_USD_PER_GB_MONTH,
  freeAllowanceBytes: 0,
  minimumCents: 0,
};

/** Hours in the UTC calendar month containing `atMs` (handles 28/29/30/31 days). */
export function hoursInMonth(atMs: number): number {
  const d = new Date(atMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return (end - start) / 3_600_000;
}

/** The UTC calendar month containing `atMs`. */
export function monthBounds(atMs: number): BillingPeriod {
  const d = new Date(atMs);
  return {
    startMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    endMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/** `YYYY-MM` label for a usage period. */
export function monthKey(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Integrate stored bytes over time.
 *
 * Each sample's value is held until the next sample (a step function), which is
 * what "bytes stored between these two measurements" means. `carryInBytes` is
 * the amount already stored when the period opened.
 */
export function byteHours(
  samples: readonly UsageSample[],
  period: BillingPeriod,
  carryInBytes = 0,
): number {
  if (period.endMs <= period.startMs) return 0;
  const sorted = [...samples]
    .filter((s) => Number.isFinite(s.atMs) && Number.isFinite(s.logicalBytes))
    .sort((a, b) => a.atMs - b.atMs);

  let total = 0;
  let cursor = period.startMs;
  let current = Math.max(0, carryInBytes);

  for (const sample of sorted) {
    if (sample.atMs <= period.startMs) {
      current = Math.max(0, sample.logicalBytes);
      continue;
    }
    if (sample.atMs >= period.endMs) break;
    total += current * ((sample.atMs - cursor) / 3_600_000);
    cursor = sample.atMs;
    current = Math.max(0, sample.logicalBytes);
  }

  total += current * ((period.endMs - cursor) / 3_600_000);
  return total;
}

/** Convert byte-hours into GB-months for the month that contains the period. */
export function gbMonthsFromByteHours(value: number, hoursInThatMonth: number): number {
  if (hoursInThatMonth <= 0) return 0;
  return value / (BYTES_PER_GB * hoursInThatMonth);
}

export function usdFromGbMonths(gbMonths: number, policy = DEFAULT_BILLING_POLICY): number {
  return gbMonths * policy.pricePerGbMonth;
}

/** Round half-up to whole cents; a charge is never negative. */
export function toCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 100 + Number.EPSILON);
}

export function formatUsd(usd: number): string {
  const sign = usd < 0 ? '-' : '';
  return `${sign}$${Math.abs(usd).toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let index = 0;
  let value = bytes;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  const digits = value < 10 && index > 0 ? 2 : index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export interface UsageQuote {
  /** Integrated byte-hours in the period so far. */
  byteHours: number;
  /** Billable GB-months accrued so far. */
  gbMonths: number;
  /** Charge for what has accrued so far, before any minimum. */
  accruedUsd: number;
  /** Charge if current usage continues to the end of the month. */
  projectedUsd: number;
  /** `projectedUsd` after the configured minimum is applied. */
  projectedUsdWithMinimum: number;
  /** Bytes stored at the end of the measured window. */
  currentLogicalBytes: number;
  /** Bytes that were excluded by the free allowance. */
  freeAllowanceAppliedBytes: number;
}

/**
 * Quote month-to-date usage and project the full month.
 *
 * `nowMs` is the end of the measured window; the projection assumes
 * `currentLogicalBytes` stays constant for the rest of the calendar month.
 */
export function quoteMonth(
  samples: readonly UsageSample[],
  nowMs: number,
  opts: { carryInBytes?: number; policy?: BillingPolicy } = {},
): UsageQuote {
  const policy = opts.policy ?? DEFAULT_BILLING_POLICY;
  const month = monthBounds(nowMs);
  const hours = hoursInMonth(nowMs);

  const billable = (bytes: number) => Math.max(0, bytes - policy.freeAllowanceBytes);

  const elapsed: BillingPeriod = { startMs: month.startMs, endMs: Math.max(nowMs, month.startMs) };
  const billableSamples = samples.map((s) => ({
    atMs: s.atMs,
    logicalBytes: billable(s.logicalBytes),
  }));

  const accruedByteHours = byteHours(billableSamples, elapsed, billable(opts.carryInBytes ?? 0));
  const accruedGbMonths = gbMonthsFromByteHours(accruedByteHours, hours);

  const lastSample = [...samples].sort((a, b) => a.atMs - b.atMs).at(-1);
  const currentLogicalBytes = lastSample?.logicalBytes ?? opts.carryInBytes ?? 0;

  const remainingHours = Math.max(0, (month.endMs - Math.max(nowMs, month.startMs)) / 3_600_000);
  const projectedByteHours = accruedByteHours + billable(currentLogicalBytes) * remainingHours;
  const projectedUsd = usdFromGbMonths(gbMonthsFromByteHours(projectedByteHours, hours), policy);

  const minimumUsd = policy.minimumCents / 100;
  return {
    byteHours: accruedByteHours,
    gbMonths: accruedGbMonths,
    accruedUsd: usdFromGbMonths(accruedGbMonths, policy),
    projectedUsd,
    projectedUsdWithMinimum:
      policy.minimumCents > 0 ? Math.max(projectedUsd, minimumUsd) : projectedUsd,
    currentLogicalBytes,
    freeAllowanceAppliedBytes: Math.min(policy.freeAllowanceBytes, currentLogicalBytes),
  };
}

/** Marginal raw storage cost of keeping two independent encrypted copies. */
export function rawTwoCopyCostUsd(logicalBytes: number, months = 1): number {
  const gb = logicalBytes / BYTES_PER_GB;
  const { primaryR2, secondaryB2 } = {
    primaryR2: 0.015,
    secondaryB2: 0.00695,
  };
  return gb * (primaryR2 + secondaryB2) * months;
}
