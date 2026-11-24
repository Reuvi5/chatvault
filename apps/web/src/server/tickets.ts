/**
 * Upload and download authorizations (plan §10: "Issue short-lived scoped
 * upload permission").
 *
 * A ticket is a signed statement of exactly one permission: this account may
 * write (or read) this one object, until this time. It is signed with the server
 * key, carries no secrets, and is useless for any other object or account.
 *
 * With the S3 drivers these tickets front our own endpoints rather than being
 * presigned provider URLs, which keeps provider credentials on the server and
 * lets us verify the ciphertext digest before an object is accepted.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TICKET_TTL_SECONDS } from '@chatvault/protocol';
import { getEnv } from './env';
import { forbidden } from './http';

export type TicketOperation = 'upload' | 'download';

export interface TicketClaims {
  v: 1;
  op: TicketOperation;
  accountId: string;
  objectId: string;
  storageKey: string;
  importId?: string;
  /** For uploads: the largest ciphertext we agreed to accept. */
  maxBytes?: number;
  expiresAtMs: number;
}

function sign(payload: string): string {
  return createHmac('sha256', getEnv().serverSecret).update(payload).digest('base64url');
}

export function issueTicket(
  claims: Omit<TicketClaims, 'v' | 'expiresAtMs'>,
  ttlSeconds = TICKET_TTL_SECONDS,
): { ticket: string; expiresAtMs: number } {
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  const full: TicketClaims = { v: 1, expiresAtMs, ...claims };
  const payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return { ticket: `${payload}.${sign(payload)}`, expiresAtMs };
}

export function verifyTicket(
  ticket: string | null,
  expected: { op: TicketOperation; accountId: string; objectId?: string },
): TicketClaims {
  if (!ticket) throw forbidden('This upload or download was not authorized.');
  const [payload, signature] = ticket.split('.');
  if (!payload || !signature) throw forbidden('That authorization is malformed.');

  const expectedSignature = Buffer.from(sign(payload));
  const givenSignature = Buffer.from(signature);
  if (
    expectedSignature.length !== givenSignature.length ||
    !timingSafeEqual(expectedSignature, givenSignature)
  ) {
    throw forbidden('That authorization does not check out.');
  }

  let claims: TicketClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TicketClaims;
  } catch {
    throw forbidden('That authorization is malformed.');
  }

  if (claims.v !== 1) throw forbidden('That authorization uses an unsupported format.');
  if (claims.op !== expected.op)
    throw forbidden('That authorization is for a different operation.');
  if (claims.accountId !== expected.accountId) {
    throw forbidden('That authorization belongs to a different account.');
  }
  if (expected.objectId && claims.objectId !== expected.objectId) {
    throw forbidden('That authorization is for a different object.');
  }
  if (claims.expiresAtMs <= Date.now()) {
    throw forbidden('That authorization has expired. Start the transfer again.');
  }
  return claims;
}
