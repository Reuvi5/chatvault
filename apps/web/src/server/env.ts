/**
 * Configuration.
 *
 * Local development works with no configuration at all: a file-backed metadata
 * store and on-disk object storage under `.data/`. Deployment requires real
 * values, and the checks below refuse to start rather than quietly run a
 * production server on the development defaults.
 *
 * The two commercial decisions the plan leaves open (§14.1, §14.2) are flags
 * here, and both default to *off*, because the plan records the $2.99 floor as a
 * recommendation that was never approved.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  BYTES_PER_GB,
  DEFAULT_TRASH_RETENTION_DAYS,
  PRICE_USD_PER_GB_MONTH,
} from '@chatvault/protocol';

/*
 * Paths here are assembled from strings rather than with `node:path`.
 * The bundler treats `path.resolve` on a value it cannot see through as
 * filesystem access and then traces the whole project into the server output,
 * which bloats a deployment with every source file. These two helpers do the
 * same job for the shapes we actually need.
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
}

function absolutePath(value: string, base: string): string {
  const combined = isAbsolutePath(value) ? value : `${base}/${value}`;
  return combined.replace(/[\\/]+$/u, '') || '/';
}

function childPath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/u, '')}/${name}`;
}

/** Thrown when the deployment is misconfigured, so it can be reported as 503. */
export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`ChatVault refused to start:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigurationError';
  }
}

export type ObjectDriverKind = 'local' | 's3';

export interface ProviderConfig {
  /** Short label used in replica rows and in the operations view. */
  label: string;
  kind: ObjectDriverKind;
  /** Directory for the local driver. */
  directory?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Bytes per upload part. S3 multipart requires at least 5 MiB per part. */
  partSizeBytes: number;
  /**
   * Artificial delay per operation, for the local driver only.
   *
   * A local directory answers in microseconds, which hides everything latency
   * does to an import: it is why a concurrency change looks like noise here and
   * like a real difference against a bucket on the other side of the world. Set
   * this to a plausible round trip (40-120ms) to see the real shape without a
   * cloud account. Refused in production.
   */
  latencyMs: number;
}

export interface BillingConfig {
  pricePerGbMonth: number;
  freeAllowanceBytes: number;
  /** 0 means "no minimum charge", which is the default and the approved state. */
  minimumCents: number;
  quotaBytes: number;
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  stripePriceId: string | null;
  stripeMeterEventName: string;
}

export interface Env {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  appUrl: string;
  dataDir: string;
  databaseUrl: string | null;
  /** Signs session cookies and upload tickets, and encrypts TOTP secrets. */
  serverSecret: string;
  primary: ProviderConfig;
  secondary: ProviderConfig | null;
  billing: BillingConfig;
  trashRetentionDays: number;
  /** Test switch for the disaster drill: pretend the primary is unreachable. */
  simulatePrimaryDown: boolean;
  emailDriver: 'console' | 'none';
  passwordArgon2: { memoryKiB: number; iterations: number; parallelism: number };
  /** Requests per minute per client for sensitive routes. */
  rateLimits: { auth: number; upload: number; read: number };
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function developmentSecret(dataDir: string): string {
  const path = childPath(dataDir, 'dev-server-secret');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

function provider(
  prefix: 'PRIMARY' | 'SECONDARY',
  dataDir: string,
  fallbackLabel: string,
): ProviderConfig | null {
  const kind = (process.env[`${prefix}_DRIVER`] ?? '').trim().toLowerCase();
  const bucket = process.env[`${prefix}_BUCKET`];
  const label = process.env[`${prefix}_LABEL`] ?? fallbackLabel;

  if (kind === 's3' || (kind === '' && bucket)) {
    return {
      label,
      kind: 's3',
      bucket,
      endpoint: process.env[`${prefix}_ENDPOINT`],
      region: process.env[`${prefix}_REGION`] ?? 'auto',
      accessKeyId: process.env[`${prefix}_ACCESS_KEY_ID`],
      secretAccessKey: process.env[`${prefix}_SECRET_ACCESS_KEY`],
      partSizeBytes: number(process.env[`${prefix}_PART_SIZE_BYTES`], 8 * 1024 * 1024),
      latencyMs: 0,
    };
  }
  if (kind === 'local' || kind === '') {
    if (prefix === 'SECONDARY' && kind === '') {
      return {
        label,
        kind: 'local',
        directory: absolutePath(
          process.env.SECONDARY_DIRECTORY ?? childPath(dataDir, 'objects-secondary'),
          dataDir,
        ),
        partSizeBytes: number(process.env.SECONDARY_PART_SIZE_BYTES, 1024 * 1024),
        latencyMs: number(process.env.SECONDARY_LATENCY_MS, 0),
      };
    }
    return {
      label,
      kind: 'local',
      directory: absolutePath(
        process.env[`${prefix}_DIRECTORY`] ??
          childPath(dataDir, prefix === 'PRIMARY' ? 'objects-primary' : 'objects-secondary'),
        dataDir,
      ),
      partSizeBytes: number(process.env[`${prefix}_PART_SIZE_BYTES`], 1024 * 1024),
      latencyMs: number(process.env[`${prefix}_LATENCY_MS`], 0),
    };
  }
  if (kind === 'none') return null;
  throw new Error(`${prefix}_DRIVER must be "local", "s3" or "none" (got "${kind}")`);
}

function load(): Env {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const dataDir = absolutePath(process.env.CHATVAULT_DATA_DIR ?? '.data', process.cwd());

  const primary = provider('PRIMARY', dataDir, 'primary');
  if (!primary) throw new Error('A primary object store is required.');
  const secondary = provider('SECONDARY', dataDir, 'secondary');

  const serverSecret =
    process.env.SERVER_SECRET ?? (isProduction ? '' : developmentSecret(dataDir));

  const env: Env = {
    nodeEnv,
    isProduction,
    appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/u, ''),
    dataDir,
    databaseUrl: process.env.DATABASE_URL?.trim() || null,
    serverSecret,
    primary,
    secondary,
    billing: {
      pricePerGbMonth: number(process.env.PRICE_USD_PER_GB_MONTH, PRICE_USD_PER_GB_MONTH),
      freeAllowanceBytes: number(process.env.FREE_ALLOWANCE_GB, 0) * BYTES_PER_GB,
      minimumCents: number(process.env.BILLING_MINIMUM_CENTS, 0),
      quotaBytes: number(process.env.ACCOUNT_QUOTA_GB, 2000) * BYTES_PER_GB,
      stripeSecretKey: process.env.STRIPE_SECRET_KEY?.trim() || null,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || null,
      stripePriceId: process.env.STRIPE_PRICE_ID?.trim() || null,
      stripeMeterEventName: process.env.STRIPE_METER_EVENT_NAME ?? 'chatvault_gb_month',
    },
    trashRetentionDays: number(process.env.TRASH_RETENTION_DAYS, DEFAULT_TRASH_RETENTION_DAYS),
    simulatePrimaryDown: boolean(process.env.SIMULATE_PRIMARY_DOWN),
    emailDriver: (process.env.EMAIL_DRIVER ?? 'console') === 'none' ? 'none' : 'console',
    passwordArgon2: {
      memoryKiB: number(process.env.PASSWORD_ARGON2_MEMORY_KIB, 64 * 1024),
      iterations: number(process.env.PASSWORD_ARGON2_ITERATIONS, 3),
      parallelism: number(process.env.PASSWORD_ARGON2_PARALLELISM, 1),
    },
    rateLimits: {
      auth: number(process.env.RATE_LIMIT_AUTH_PER_MIN, 10),
      upload: number(process.env.RATE_LIMIT_UPLOAD_PER_MIN, 600),
      read: number(process.env.RATE_LIMIT_READ_PER_MIN, 1200),
    },
  };

  /*
   * Local inspection of the optimised build.
   *
   * `npm run build && npm run start:local` runs the production bundle against
   * the development file store so the build can be checked on a laptop. It is
   * deliberately awkward to switch on — the flag plus a localhost APP_URL — and
   * it announces itself on every start, because running real customer data this
   * way would mean a single-process metadata store and no second provider.
   */
  const localProductionAllowed =
    boolean(process.env.CHATVAULT_UNSAFE_LOCAL_PRODUCTION) &&
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(env.appUrl);

  if (isProduction && localProductionAllowed) {
    console.warn(
      [
        '',
        '  ChatVault is running the production build with DEVELOPMENT storage.',
        '  The metadata store is a single-process file store and object storage is a',
        '  local directory. Do not put real customer data anywhere near this.',
        '',
      ].join('\n'),
    );
  }

  if (isProduction && !localProductionAllowed) {
    const problems: string[] = [];
    if (serverSecret.length < 32) {
      problems.push('SERVER_SECRET must be set to at least 32 random characters.');
    }
    if (!env.databaseUrl) {
      problems.push('DATABASE_URL must point at Postgres; the file store is for development only.');
    }
    if (primary.kind !== 's3') {
      problems.push('PRIMARY_DRIVER must be "s3" in production (Cloudflare R2 in the plan).');
    }
    if (!secondary) {
      problems.push(
        'A secondary provider is required: the product only reports an archive as Verified once two independent copies exist.',
      );
    } else if (secondary.kind !== 's3') {
      problems.push('SECONDARY_DRIVER must be "s3" in production (Backblaze B2 in the plan).');
    }
    if (secondary?.kind === 's3' && primary.kind === 's3') {
      if (secondary.accessKeyId && secondary.accessKeyId === primary.accessKeyId) {
        problems.push(
          'The two providers must use separate credentials, so one leaked key cannot reach both copies.',
        );
      }
    }
    if (env.simulatePrimaryDown)
      problems.push('SIMULATE_PRIMARY_DOWN must not be set in production.');
    if (problems.length > 0) throw new ConfigurationError(problems);
  }

  return env;
}

let cached: Env | null = null;

export function getEnv(): Env {
  cached ??= load();
  return cached;
}

/** Test helper: forget the cached configuration. */
export function resetEnvForTests(): void {
  cached = null;
}
