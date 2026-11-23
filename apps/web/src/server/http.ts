/**
 * HTTP plumbing: one error envelope, one place that turns thrown errors into
 * responses, and request validation that never trusts a body.
 *
 * Route handlers are plain functions over `Request`, which is what makes them
 * directly testable without starting a server.
 */
import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import type { ApiErrorCode } from '@chatvault/protocol';
import { ConfigurationError } from './env';
import { log } from './log';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in to continue.') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to that.') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);
export const payloadTooLarge = (message: string) =>
  new HttpError(413, 'payload_too_large', message);
export const quotaExceeded = (message: string, details?: unknown) =>
  new HttpError(402, 'quota_exceeded', message, details);
export const rateLimited = (message = 'Too many requests. Try again shortly.') =>
  new HttpError(429, 'rate_limited', message);
export const notConfigured = (message: string) =>
  new HttpError(501, 'not_configured', message);

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers ?? {}),
    },
  });
}

export function emptyResponse(init: ResponseInit = {}): Response {
  return new Response(null, {
    status: 204,
    ...init,
    headers: { 'cache-control': 'no-store', ...(init.headers ?? {}) },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ConfigurationError) {
    // The details belong in the operator's logs, not in a public response.
    log.error('This deployment is misconfigured and refused the request', {
      problems: error.problems,
    });
    return jsonResponse(
      {
        error: {
          code: 'internal' satisfies ApiErrorCode,
          message:
            'This deployment is not configured correctly, so nothing was changed. The server log lists what is missing.',
        },
      },
      { status: 503 },
    );
  }
  if (error instanceof HttpError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } },
      { status: error.status },
    );
  }
  log.error('Unhandled error in a route handler', { error });
  return jsonResponse(
    {
      error: {
        code: 'internal' satisfies ApiErrorCode,
        message: 'Something went wrong on our side. Nothing was changed.',
      },
    },
    { status: 500 },
  );
}

/** Wraps a handler so every thrown error becomes the same envelope. */
export function route<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    try {
      return await handler(request, ...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

const MAX_JSON_BYTES = 512 * 1024;

export async function readJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_JSON_BYTES) {
    throw payloadTooLarge('That request body is too large.');
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw payloadTooLarge('That request body is too large.');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
}

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) {
    throw badRequest(
      'Some fields were missing or invalid.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  const object: Record<string, string> = {};
  for (const [key, value] of url.searchParams) object[key] = value;
  const parsed = schema.safeParse(object);
  if (!parsed.success) throw badRequest('Some query parameters were invalid.');
  return parsed.data;
}

/**
 * A stable, non-reversible handle for a client, used for rate limiting and
 * audit rows. We never store a raw IP address.
 */
export function clientHash(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || request.headers.get('x-real-ip') || 'unknown';
  const agent = request.headers.get('user-agent') ?? '';
  return createHash('sha256').update(`${ip}|${agent}`).digest('hex').slice(0, 32);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
