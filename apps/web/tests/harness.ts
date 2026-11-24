/**
 * Test harness.
 *
 * Each test file gets its own data directory, its own server secret and its own
 * pair of local "providers", and drives the real route handlers through the
 * in-process router. Nothing is mocked: the tests exercise the same
 * authorisation, encryption, metering and replication code that serves the app.
 */
import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'chatvault-test-'));
process.env.CHATVAULT_DATA_DIR = dataDir;
process.env.SERVER_SECRET = randomBytes(32).toString('base64url');
process.env.PRIMARY_DRIVER = 'local';
process.env.SECONDARY_DRIVER = 'local';
process.env.PRIMARY_LABEL = 'primary-test';
process.env.SECONDARY_LABEL = 'secondary-test';
process.env.PRIMARY_PART_SIZE_BYTES = '65536';
process.env.RATE_LIMIT_AUTH_PER_MIN = '1000';
process.env.RATE_LIMIT_UPLOAD_PER_MIN = '100000';
process.env.RATE_LIMIT_READ_PER_MIN = '100000';
process.env.PASSWORD_ARGON2_MEMORY_KIB = '8192';
process.env.PASSWORD_ARGON2_ITERATIONS = '1';
delete process.env.DATABASE_URL;
delete process.env.SIMULATE_PRIMARY_DOWN;
delete process.env.STRIPE_SECRET_KEY;

import {
  ApiClient,
  ArchiveReader,
  bytesImportSource,
  previewImport,
  runImport,
  type ImportOutcome,
  type ImportPreview,
} from '@chatvault/client';
import { FAST_ARGON2ID_PARAMS, createVault, type UnlockedVault } from '@chatvault/crypto';
import { buildSyntheticExport, type SyntheticExportOptions } from '@chatvault/parser';
import { CookieJar, createLocalFetch } from '@/server/localRouter';
import { getStore, resetStoreForTests } from '@/server/db/index';
import { getEnv, resetEnvForTests } from '@/server/env';
import { resetDriversForTests } from '@/server/objects/index';
import { resetRateLimitsForTests } from '@/server/security';

export const TEST_DATA_DIR = dataDir;
export const TEST_PASSWORD = 'a-long-enough-test-password';
export const TEST_PASSPHRASE = 'seventeen velvet otters argue';

export interface TestAccount {
  api: ApiClient;
  jar: CookieJar;
  email: string;
  accountId: string;
  vault: UnlockedVault;
  recoveryKeyDisplay: string;
}

export function newClient(clientIp = '127.0.0.1'): { api: ApiClient; jar: CookieJar } {
  const jar = new CookieJar();
  return { api: new ApiClient({ fetchImpl: createLocalFetch({ jar, clientIp }) }), jar };
}

/** Sign up, confirm the address and create an archive key. */
export async function createAccount(options: { verify?: boolean } = {}): Promise<TestAccount> {
  const { api, jar } = newClient();
  const email = `t-${randomBytes(5).toString('hex')}@example.test`;
  const signup = await api.signup(email, TEST_PASSWORD);
  if (options.verify !== false) {
    const token = new URL(signup.verificationUrl ?? 'http://x/?token=').searchParams.get('token');
    if (!token) throw new Error('No verification token was returned');
    await api.verifyEmail(token);
  }
  const created = await createVault(TEST_PASSPHRASE, { argon2: FAST_ARGON2ID_PARAMS });
  await api.createVault(created.vault.bundle, 'UTC');
  return {
    api,
    jar,
    email,
    accountId: signup.accountId,
    vault: created.vault,
    recoveryKeyDisplay: created.recoveryKeyDisplay,
  };
}

export interface ImportedFixture {
  preview: ImportPreview;
  outcome: ImportOutcome;
}

/** Import a synthetic export for an account. */
export async function importFixture(
  account: TestAccount,
  options: SyntheticExportOptions & { conversationId?: string | null } = {},
): Promise<ImportedFixture> {
  const fixture = buildSyntheticExport({
    platform: 'android',
    withMedia: true,
    messageCount: 30,
    seed: 99,
    ...options,
  });
  const source = bytesImportSource(fixture.fileName, fixture.bytes);
  const preview = await previewImport({ source });
  const outcome = await runImport({
    api: account.api,
    vault: account.vault,
    source,
    preview,
    assumedTimeZone: 'UTC',
    conversationId: options.conversationId ?? null,
  });
  return { preview, outcome };
}

export async function readerFor(account: TestAccount): Promise<ArchiveReader> {
  return ArchiveReader.create({ api: account.api, vault: account.vault });
}

export { getEnv, getStore, buildSyntheticExport, bytesImportSource, previewImport, runImport };

/** Forget cached configuration, drivers, rate limits and the store. */
export async function resetServerState(): Promise<void> {
  resetEnvForTests();
  resetDriversForTests();
  resetRateLimitsForTests();
  await resetStoreForTests();
}

export async function cleanupDataDir(): Promise<void> {
  await resetServerState();
  await rm(dataDir, { recursive: true, force: true });
}
