/**
 * Request-level protections: tickets, rate limits, body size, and the route
 * table staying in step with the real routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROUTE_TABLE, createLocalFetch } from '@/server/localRouter';
import { issueTicket, verifyTicket } from '@/server/tickets';
import { currentTotp, generateTotpSecret, verifyTotp } from '@/server/auth/totp';
import { hashPassword, needsRehash, verifyPassword } from '@/server/auth/password';
import {
  cleanupDataDir,
  createAccount,
  newClient,
  resetServerState,
  type TestAccount,
} from './harness';

let account: TestAccount;

beforeAll(async () => {
  account = await createAccount();
}, 120_000);

afterAll(async () => {
  await cleanupDataDir();
});

describe('upload and download tickets', () => {
  const claims = {
    op: 'download' as const,
    accountId: 'acc_aaaaaaaaaaaaaaaaaaaaaa',
    objectId: 'obj_bbbbbbbbbbbbbbbbbbbbbb',
    storageKey: 'v1/acc_aaaaaaaaaaaaaaaaaaaaaa/obj_bbbbbbbbbbbbbbbbbbbbbb',
  };

  it('round-trips and carries only the one permission it was issued for', () => {
    const { ticket } = issueTicket(claims);
    const verified = verifyTicket(ticket, {
      op: 'download',
      accountId: claims.accountId,
      objectId: claims.objectId,
    });
    expect(verified.storageKey).toBe(claims.storageKey);
  });

  it('is refused for another account, another object or another operation', () => {
    const { ticket } = issueTicket(claims);
    expect(() =>
      verifyTicket(ticket, { op: 'download', accountId: 'acc_cccccccccccccccccccccc' }),
    ).toThrow(/different account/i);
    expect(() =>
      verifyTicket(ticket, {
        op: 'download',
        accountId: claims.accountId,
        objectId: 'obj_dddddddddddddddddddddd',
      }),
    ).toThrow(/different object/i);
    expect(() => verifyTicket(ticket, { op: 'upload', accountId: claims.accountId })).toThrow(
      /different operation/i,
    );
  });

  it('is refused when tampered with or expired', () => {
    const { ticket } = issueTicket(claims);
    const [payload, signature] = ticket.split('.');
    expect(() =>
      verifyTicket(`${payload}x.${signature}`, { op: 'download', accountId: claims.accountId }),
    ).toThrow();
    expect(() =>
      verifyTicket(`${payload}.${signature?.slice(0, -2)}ab`, {
        op: 'download',
        accountId: claims.accountId,
      }),
    ).toThrow(/does not check out/i);

    const forged = Buffer.from(
      JSON.stringify({ ...claims, v: 1, expiresAtMs: Date.now() + 60_000 }),
    ).toString('base64url');
    expect(() =>
      verifyTicket(`${forged}.${signature}`, { op: 'download', accountId: claims.accountId }),
    ).toThrow(/does not check out/i);

    const { ticket: expired } = issueTicket(claims, -5);
    expect(() => verifyTicket(expired, { op: 'download', accountId: claims.accountId })).toThrow(
      /expired/i,
    );
  });

  it('is refused when missing entirely', () => {
    expect(() => verifyTicket(null, { op: 'download', accountId: claims.accountId })).toThrow(
      /not authorized/i,
    );
  });
});

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const record = await hashPassword('a-long-enough-password');
    expect(await verifyPassword('a-long-enough-password', record)).toBe(true);
    expect(await verifyPassword('a-long-enough-passworD', record)).toBe(false);
    expect(record.hash).not.toContain('a-long-enough-password');
  });

  it('salts every hash, so two identical passwords look different', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a.hash).not.toBe(b.hash);
  });

  it('notices when a stored hash used weaker parameters', async () => {
    const record = await hashPassword('another long password');
    expect(needsRehash(record)).toBe(false);
    expect(needsRehash({ hash: record.hash, params: 'argon2id$m=8192,t=1,p=1$c2FsdHNhbHQ' })).toBe(
      false,
    );
    expect(needsRehash({ hash: record.hash, params: 'nonsense' })).toBe(true);
  });
});

describe('time-based one-time passwords', () => {
  it('accepts the current code and rejects a wrong one', () => {
    const { secret } = generateTotpSecret();
    const code = currentTotp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
  });

  it('tolerates one step of clock drift but not ten minutes', () => {
    const { secret } = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, currentTotp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, currentTotp(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, currentTotp(secret, now - 600_000), now)).toBe(false);
  });
});

describe('rate limiting', () => {
  it('refuses a burst of sign-in attempts from one client', async () => {
    process.env.RATE_LIMIT_AUTH_PER_MIN = '3';
    await resetServerState();
    const { api } = newClient('203.0.113.7');

    const codes: Array<string | number> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await api.login('nobody@example.test', 'not-the-password');
        codes.push('ok');
      } catch (error) {
        codes.push((error as { code?: string }).code ?? 'unknown');
      }
    }
    expect(codes).toContain('rate_limited');

    process.env.RATE_LIMIT_AUTH_PER_MIN = '1000';
    await resetServerState();
  });
});

describe('request bodies', () => {
  it('refuses an oversized JSON body', async () => {
    const localFetch = createLocalFetch({ jar: account.jar });
    const response = await localFetch('/api/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(600 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it('refuses a body that is not valid JSON', async () => {
    const localFetch = createLocalFetch({ jar: account.jar });
    const response = await localFetch('/api/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('validates fields and says which ones were wrong', async () => {
    const localFetch = createLocalFetch({ jar: account.jar });
    const response = await localFetch('/api/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plannedCiphertextBytes: -1, plannedObjectCount: 'many' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details?: Array<{ path: string }> } };
    expect(body.error.details?.length).toBeGreaterThan(0);
  });
});

describe('the route table matches the real routes', () => {
  it('has an entry for every route file under src/app/api', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const root = resolve(here, '../src/app/api');

    async function walk(directory: string, prefix: string): Promise<string[]> {
      const found: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          found.push(...(await walk(path, `${prefix}/${entry.name}`)));
        } else if (entry.name === 'route.ts') {
          const source = await readFile(path, 'utf8');
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
            if (new RegExp(`export const ${method}\\b`, 'u').test(source)) {
              found.push(`${method} ${prefix}`);
            }
          }
        }
      }
      return found;
    }

    const routes = await walk(root, '/api');
    expect(routes.length).toBeGreaterThan(20);

    const missing = routes.filter((route) => {
      const [method, pattern] = route.split(' ');
      // Turn Next's [id] segments into something the patterns can match.
      const samplePath = (pattern ?? '').replace(/\[(\w+)\]/gu, 'sample');
      return !ROUTE_TABLE.some(
        (entry) => entry.method === method && entry.pattern.test(samplePath),
      );
    });
    expect(missing).toEqual([]);
  });
});
