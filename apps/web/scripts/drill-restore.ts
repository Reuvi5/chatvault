/**
 * The disaster-recovery drill (plan §15.3, §7 "Run automated restore exercises").
 *
 *   npm run drill:restore
 *
 * It proves, end to end and without a browser, that:
 *
 *   1. a synthetic export can be parsed, encrypted on the device and uploaded as
 *      ciphertext,
 *   2. the server stored exactly the bytes it was given (checksum read-back),
 *   3. the object was copied to a second, independent provider and verified
 *      there, and only then does the conversation report **Verified**,
 *   4. with the primary provider unreachable, a *different* session can restore
 *      the whole archive from the backup copy using **only the offline recovery
 *      key**, and every message and attachment matches what went in, and
 *   5. nothing readable was ever stored server-side: the drill greps the whole
 *      data directory for plaintext from the conversation and fails if it finds
 *      any.
 *
 * Exit code 0 means every check passed.
 */
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = process.env.CHATVAULT_DATA_DIR ?? (await mkdtemp(join(tmpdir(), 'chatvault-drill-')));
process.env.CHATVAULT_DATA_DIR = dataDir;
process.env.SERVER_SECRET ??= randomBytes(32).toString('base64url');
process.env.PRIMARY_DRIVER ??= 'local';
process.env.SECONDARY_DRIVER ??= 'local';
process.env.PRIMARY_LABEL ??= 'primary-local';
process.env.SECONDARY_LABEL ??= 'secondary-local';
delete process.env.SIMULATE_PRIMARY_DOWN;

const { ApiClient, ArchiveReader, bytesImportSource, previewImport, runImport } = await import(
  '@chatvault/client'
);
const { createVault, unlockWithRecoveryKey, sha256Hex } = await import('@chatvault/crypto');
const { buildSyntheticExport, parseTranscript } = await import('@chatvault/parser');
const { CookieJar, createLocalFetch } = await import('../src/server/localRouter');
const { resetEnvForTests } = await import('../src/server/env');
const { resetDriversForTests } = await import('../src/server/objects/index');

const PASSWORD = 'drill-account-password-2026';
const PASSPHRASE = 'seventeen velvet otters argue loudly';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

async function walk(directory: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function main(): Promise<number> {
  console.log(`ChatVault restore drill\ndata directory: ${dataDir}\n`);

  /* ---------------------------------------------------------------- setup */
  section('1. Account and archive key');
  const jar = new CookieJar();
  const api = new ApiClient({ fetchImpl: createLocalFetch({ jar }) });
  const email = `drill-${randomBytes(4).toString('hex')}@example.test`;

  const signup = await api.signup(email, PASSWORD);
  const token = new URL(signup.verificationUrl ?? 'http://x/?token=').searchParams.get('token');
  if (!token) throw new Error('The drill needs the development email driver to see the token.');
  await api.verifyEmail(token);
  record('account created and email confirmed', true, email);

  const created = await createVault(PASSPHRASE);
  await api.createVault(created.vault.bundle as never, 'UTC');
  record('archive key created, wrapped bundle stored', true, `key ${created.vault.keyId}`);

  /* --------------------------------------------------------------- import */
  section('2. Import a synthetic export');
  const fixture = buildSyntheticExport({
    platform: 'ios',
    withMedia: true,
    group: true,
    messageCount: 400,
    seed: 20_261_118,
  });
  const expectedMessages = parseTranscript(fixture.transcript).counts.total;
  const source = bytesImportSource(fixture.fileName, fixture.bytes);

  const preview = await previewImport({ source });
  record(
    'export parsed locally',
    preview.parsed.counts.total === expectedMessages,
    `${String(preview.parsed.counts.total)} messages, ${String(preview.attachments.length)} attachments`,
  );

  const outcome = await runImport({
    api,
    vault: created.vault,
    source,
    preview,
    assumedTimeZone: 'UTC',
  });
  record(
    'encrypted and uploaded',
    outcome.merge.added === expectedMessages,
    `${String(outcome.uploadedObjects)} objects, ${(outcome.ciphertextBytesUploaded / 1_000_000).toFixed(2)} MB of ciphertext`,
  );

  /* ---------------------------------------------------------- replication */
  section('3. Second independent copy');
  let status = await api.importStatus(outcome.importId);
  record(
    'not verified before the backup copy exists',
    !status.archiveVerified,
    `state ${status.state}`,
  );

  const replication = await api.runReplication(500);
  status = await api.importStatus(outcome.importId);
  record(
    'replicated and verified on both providers',
    status.archiveVerified && replication.failed === 0,
    `${String(replication.verified)} objects verified`,
  );

  /* ------------------------------------------------- no plaintext at rest */
  section('4. Nothing readable on the server');
  const probes = [
    'Are we still on for Thursday',
    'Dana Okonkwo',
    fixture.expected.title,
    'Cabin check-in',
  ];
  const files = await walk(dataDir);
  const leaks: string[] = [];
  for (const file of files) {
    const info = await stat(file);
    if (info.size > 64 * 1024 * 1024) continue;
    const bytes = await readFile(file);
    const text = bytes.toString('latin1');
    for (const probe of probes) {
      if (text.includes(probe)) leaks.push(`${file} contains "${probe}"`);
    }
  }
  record(
    'no message text, name or title found anywhere in stored data',
    leaks.length === 0,
    leaks.length === 0 ? `${String(files.length)} files scanned` : leaks.slice(0, 3).join('; '),
  );

  /* -------------------------------------------- restore with primary down */
  section('5. Restore from the backup copy, with the primary unreachable');
  process.env.SIMULATE_PRIMARY_DOWN = '1';
  resetEnvForTests();
  resetDriversForTests();

  const freshJar = new CookieJar();
  const restoreApi = new ApiClient({ fetchImpl: createLocalFetch({ jar: freshJar }) });
  const session = await restoreApi.login(email, PASSWORD);
  record('signed in on a fresh session', Boolean(session.vault), `vault ${session.vault?.id ?? '—'}`);

  const reopened = await unlockWithRecoveryKey(
    session.vault?.bundle as never,
    created.recoveryKeyDisplay,
  );
  record(
    'unlocked with the recovery key alone',
    reopened.keyId === created.vault.keyId,
    `key ${reopened.keyId}`,
  );

  const reader = await ArchiveReader.create({ api: restoreApi, vault: reopened });
  const entries = await reader.listConversations();
  const entry = entries.find((candidate) => candidate.summary.id === outcome.conversationId);
  if (!entry?.manifest) throw new Error('The conversation index could not be decrypted.');
  record(
    'conversation index decrypted',
    entry.manifest.title === outcome.manifest.title,
    `“${entry.manifest.title}”, ${String(entry.manifest.messageCount)} messages`,
  );

  const report = await reader.verifyIntegrity(entry.manifest, { includeMedia: true });
  record(
    'every page and attachment read back and matched its checksum',
    report.ok,
    report.ok
      ? `${String(report.pagesChecked)} pages, ${String(report.attachmentsChecked)} attachments`
      : report.problems.map((problem) => problem.detail).join('; '),
  );

  const restored = await reader.loadMessages(entry.manifest);
  const original = parseTranscript(fixture.transcript).messages;
  const sameCount = restored.length === original.length;
  const sameContent =
    (await sha256Hex(new TextEncoder().encode(JSON.stringify(restored.map((m) => m.body))))) ===
    (await sha256Hex(new TextEncoder().encode(JSON.stringify(original.map((m) => m.body)))));
  record(
    'restored messages are identical to the export',
    sameCount && sameContent,
    `${String(restored.length)} of ${String(original.length)} messages`,
  );

  const firstMedia = entry.manifest.attachments.find((item) => !item.missing && item.objectId);
  if (firstMedia) {
    const loaded = await reader.loadAttachment(firstMedia);
    record(
      'an attachment decrypts from the backup copy',
      loaded.bytes.byteLength === firstMedia.byteLength,
      `${firstMedia.fileName} (${String(loaded.bytes.byteLength)} bytes, ${loaded.mimeType})`,
    );
  }

  /* --------------------------------------------------------------- report */
  section('Result');
  const failed = checks.filter((check) => !check.ok);
  console.log(`${String(checks.length - failed.length)} of ${String(checks.length)} checks passed.`);
  if (failed.length > 0) {
    for (const check of failed) console.log(`  failed: ${check.name} — ${check.detail}`);
    console.log(
      '\nThis drill is a release gate: do not invite anyone to delete an original export until it passes.',
    );
    return 1;
  }
  console.log(
    [
      '',
      'An archive was written, verified on two providers, and then restored from the',
      'backup copy alone, with the primary deliberately unreachable and using only the',
      'offline recovery key. No plaintext was found in anything the server stored.',
      '',
      `Data directory kept for inspection: ${resolve(dataDir)}`,
    ].join('\n'),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('\nThe drill stopped with an error:');
    console.error(error);
    process.exit(1);
  });
