/**
 * Versioned format constants.
 *
 * Every on-disk / on-the-wire structure carries its version so that future
 * clients can read archives written today (plan §6.3 item 7, §8 "versioned
 * canonical format").
 */

/** Encrypted object container format version. */
export const OBJECT_FORMAT_VERSION = 1;

/** Vault key bundle (wrapped master key) format version. */
export const VAULT_BUNDLE_VERSION = 1;

/** Conversation manifest schema version. */
export const MANIFEST_VERSION = 1;

/** Transcript parser version, recorded on every import for reproducibility. */
export const PARSER_VERSION = 3;

/** Plaintext bytes per authenticated frame inside an encrypted object. */
export const DEFAULT_FRAME_SIZE = 1 << 20; // 1 MiB

/** Messages per encrypted "page" object, so the viewer can paginate. */
export const MESSAGES_PER_PAGE = 500;

/**
 * A gigabyte is 1,000,000,000 bytes for every pricing and usage display.
 * Plan §9: "Define a GB as 1,000,000,000 bytes for pricing and show this in the UI."
 */
export const BYTES_PER_GB = 1_000_000_000;

/** Agreed customer price: $0.05 per logical GB stored per month (plan §9). */
export const PRICE_USD_PER_GB_MONTH = 0.05;

/** Raw list rates recorded in the plan on 2026-11-17, for margin reporting only. */
export const RAW_COST_USD_PER_GB_MONTH = {
  primaryR2: 0.015,
  secondaryB2: 0.00695,
} as const;

/** Safety limits for untrusted import files (plan §13 "Untrusted ZIP"). */
export const IMPORT_LIMITS = {
  /** Largest accepted export archive. */
  maxArchiveBytes: 8 * 1024 * 1024 * 1024,
  /** Largest accepted single attachment. */
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  /** Largest accepted transcript (.txt) inside an archive. */
  maxTranscriptBytes: 256 * 1024 * 1024,
  /** Largest number of members in an archive. */
  maxEntries: 200_000,
  /** Maximum total uncompressed bytes / compressed bytes before we bail out. */
  maxCompressionRatio: 200,
  /** Maximum frames in one encrypted object. */
  maxFramesPerObject: 262_144,
} as const;

/** Lifetime of a scoped upload/download authorization. */
export const TICKET_TTL_SECONDS = 15 * 60;

/** How long a soft-deleted archive stays recoverable (plan §14.5 default proposal). */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/** Replication attempts before an object is parked in the dead-letter state. */
export const MAX_REPLICATION_ATTEMPTS = 6;
