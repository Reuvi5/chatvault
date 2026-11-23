/**
 * Sessions.
 *
 * A random 32-byte token in an HttpOnly cookie; only its SHA-256 is stored, so
 * a leaked database cannot be used to impersonate anyone. Every authenticated
 * route resolves the cookie to an account here, and every query downstream is
 * scoped to that account (plan §5: authorisation never relies merely on being
 * logged in).
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@chatvault/protocol';
import { getEnv } from '../env';
import { getStore, type RowOf, type Store } from '../db/index';
import { clientHash, sha256Hex, unauthorized } from '../http';

export const SESSION_COOKIE = 'cv_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 60 * 60 * 1000;

export interface Authenticated {
  account: RowOf<'accounts'>;
  session: RowOf<'sessions'>;
  /** Convenience: the scope every store call for this request must use. */
  accountId: string;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookieHeader(token: string, expiresAtMs: number): string {
  const secure = getEnv().appUrl.startsWith('https://') ? '; Secure' : '';
  const expires = new Date(expiresAtMs).toUTCString();
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expires}`;
}

export function clearedCookieHeader(): string {
  const secure = getEnv().appUrl.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

export async function createSession(
  store: Store,
  accountId: string,
  request: Request,
): Promise<{ token: string; expiresAtMs: number; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAtMs = now + SESSION_TTL_MS;
  const sessionId = newId('ses');
  await store.insert('sessions', {
    id: sessionId,
    account_id: accountId,
    token_hash: sha256Hex(token),
    created_at_ms: now,
    expires_at_ms: expiresAtMs,
    last_seen_ms: now,
    client_hash: clientHash(request),
  });
  return { token, expiresAtMs, sessionId };
}

export async function destroySession(store: Store, sessionId: string): Promise<void> {
  await store.remove('sessions', sessionId);
}

export async function destroyAllSessions(store: Store, accountId: string): Promise<void> {
  await store.removeWhere('sessions', { equals: { account_id: accountId } });
}

export async function resolveSession(request: Request): Promise<Authenticated | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const store = await getStore();
  const tokenHash = sha256Hex(token);

  // The lookup is by token hash, which is unique, and the account is then
  // loaded by its own identifier: a session can only ever reach its own owner.
  const session = await store.findOne('sessions', { equals: { token_hash: tokenHash } });
  if (!session) return null;
  if (session.expires_at_ms <= Date.now()) {
    await store.remove('sessions', session.id);
    return null;
  }
  const account = await store.get('accounts', session.account_id);
  if (!account || account.state !== 'active') return null;

  if (Date.now() - session.last_seen_ms > SESSION_REFRESH_MS) {
    await store.update('sessions', session.id, { last_seen_ms: Date.now() });
  }
  return { account, session, accountId: account.id };
}

export async function requireSession(request: Request): Promise<Authenticated> {
  const authenticated = await resolveSession(request);
  if (!authenticated) throw unauthorized();
  return authenticated;
}

/** Routes that touch an archive additionally require a verified email. */
export async function requireVerifiedSession(request: Request): Promise<Authenticated> {
  const authenticated = await requireSession(request);
  if (!authenticated.account.email_verified) {
    throw unauthorized('Confirm your email address before importing anything.');
  }
  return authenticated;
}
