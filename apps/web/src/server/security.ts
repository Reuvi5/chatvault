/**
 * Rate limiting, replay protection and the audit trail.
 *
 * The rate limiter is in-process, which is right for one server and for local
 * development but not for several instances behind a load balancer; swap in a
 * shared counter (Redis, Durable Objects) before scaling out. The limit it
 * enforces is a cap per client per minute, not a security boundary on its own.
 */
import { newId } from '@chatvault/protocol';
import { getStore, type Store } from './db/index';
import { log } from './log';
import { conflict, rateLimited, sha256Hex } from './http';

interface Bucket {
  count: number;
  resetAtMs: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

export function enforceRateLimit(key: string, perMinute: number): void {
  if (perMinute <= 0) return;
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAtMs <= now) {
    if (buckets.size > MAX_BUCKETS) buckets.clear();
    buckets.set(key, { count: 1, resetAtMs: now + 60_000 });
    return;
  }
  existing.count += 1;
  if (existing.count > perMinute) {
    /*
     * Tell the caller how long this window still has to run. A legitimate
     * import is request-heavy by nature — it is the one thing this product
     * exists to do — so the right answer to a client that is going too fast is
     * "wait this long", not "give up".
     */
    throw rateLimited((existing.resetAtMs - now) / 1000);
  }
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}

/* ------------------------------------------------------------------- audit */

export type AuditKind =
  | 'account.created'
  | 'account.login'
  | 'account.login_failed'
  | 'account.logout'
  | 'account.mfa_enabled'
  | 'account.deletion_requested'
  | 'vault.created'
  | 'vault.bundle_updated'
  | 'import.created'
  | 'import.completed'
  | 'import.failed'
  | 'object.rejected'
  | 'conversation.trashed'
  | 'conversation.restored'
  | 'conversation.purged'
  | 'replication.failed'
  | 'billing.updated'
  | 'authz.denied';

/**
 * Audit rows hold no chat content: a kind, a short non-sensitive detail, the
 * account and a hashed client handle (plan §5 "minimal non-content security
 * and account events").
 */
export async function recordAudit(
  store: Store,
  event: {
    accountId: string | null;
    kind: AuditKind;
    detail: string;
    clientHash?: string | null;
  },
): Promise<void> {
  try {
    await store.insert('security_audit_events', {
      id: newId('evt'),
      account_id: event.accountId,
      kind: event.kind,
      detail: event.detail.slice(0, 300),
      client_hash: event.clientHash ?? null,
      at_ms: Date.now(),
    });
  } catch (error) {
    // Never fail a request because the audit row could not be written.
    log.warn('Could not record an audit event', { kind: event.kind, error });
  }
}

/* ----------------------------------------------------------- idempotency */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Replay protection for write operations (plan §10 "Use idempotency keys for
 * write operations"). A repeated request with the same key returns the first
 * response; the same key with a different body is a conflict.
 */
export async function withIdempotency<T>(
  options: {
    accountId: string;
    route: string;
    key: string | null;
    requestBody: unknown;
  },
  operation: () => Promise<T>,
): Promise<T> {
  if (!options.key) return operation();
  const store = await getStore();
  const id = sha256Hex(`${options.accountId}|${options.route}|${options.key}`);
  const requestHash = sha256Hex(JSON.stringify(options.requestBody ?? null));
  const now = Date.now();

  const existing = await store.get('idempotency_keys', id);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw conflict('That idempotency key was already used with a different request.');
    }
    if (existing.state === 'completed' && existing.response_json) {
      return JSON.parse(existing.response_json) as T;
    }
    if (existing.state === 'in_flight' && existing.created_at_ms > now - 60_000) {
      throw conflict('That request is still being processed.');
    }
  } else {
    await store.insert('idempotency_keys', {
      id,
      account_id: options.accountId,
      route: options.route,
      request_hash: requestHash,
      response_json: null,
      state: 'in_flight',
      created_at_ms: now,
      expires_at_ms: now + IDEMPOTENCY_TTL_MS,
    });
  }

  try {
    const result = await operation();
    await store.update('idempotency_keys', id, {
      state: 'completed',
      response_json: JSON.stringify(result ?? null),
    });
    return result;
  } catch (error) {
    await store.remove('idempotency_keys', id).catch(() => undefined);
    throw error;
  }
}

/** Housekeeping, called by the worker. */
export async function purgeExpiredSecurityRows(
  store: Store,
): Promise<{ sessions: number; keys: number }> {
  const now = Date.now();
  const sessions = await store.removeWhere('sessions', {
    lessThan: { column: 'expires_at_ms', value: now },
  });
  const keys = await store.removeWhere('idempotency_keys', {
    lessThan: { column: 'expires_at_ms', value: now },
  });
  return { sessions, keys };
}
